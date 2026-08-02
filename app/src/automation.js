const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// puppeteer >= 25 ships as ESM-only: require('puppeteer') throws
// ERR_REQUIRE_ESM, so it must be loaded lazily via dynamic import().
let _puppeteerMod = null;
async function getPuppeteer() {
    if (!_puppeteerMod) {
        const m = await import('puppeteer');
        _puppeteerMod = m.default || m;
    }
    return _puppeteerMod;
}

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Writable user data dir for logs and overrides.
const USER_DATA_DIR = app.getPath('userData');
const LOG_PATH = path.join(USER_DATA_DIR, 'automation.log');
const LOG_MAX_BYTES = 1024 * 1024; // 1 MB
function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
        // Rotate when log grows past 1 MB so the file doesn't grow forever.
        try {
            const st = fs.statSync(LOG_PATH);
            if (st.size > LOG_MAX_BYTES) {
                try { fs.renameSync(LOG_PATH, LOG_PATH + '.old'); } catch (e) {}
            }
        } catch (e) { /* file doesn't exist yet — fine */ }
        fs.appendFileSync(LOG_PATH, line);
    } catch (e) {}
    process.stderr.write(line);
}

const SELECTORS = {
    title: '#ad-title', description: '#ad-description', price: '#ad-price-amount',
    priceType: '#ad-price-type', zipCode: '#ad-zip-code', street: '#ad-street',
    addressVisibility: '#ad-address-visibility', photoUploadInput: 'input[type="file"][accept*="image"]',
};

// Read shipping options from userData if the user has refreshed it, else from the bundled defaults.
const SHIPPING_BUNDLED = path.join(__dirname, '..', 'shipping-options.json');
const SHIPPING_USER = path.join(USER_DATA_DIR, 'shipping-options.json');
function shippingFile() { return fs.existsSync(SHIPPING_USER) ? SHIPPING_USER : SHIPPING_BUNDLED; }
const SIZE_RANK = { SMALL: 0, MEDIUM: 1, LARGE: 2 };

// Build a { carrierId: packageSize } map from the scraped shipping-options.json.
// This is the source of truth — refresh via the UI's 🔄 button to update it.
// Returns null if the file isn't present, in which case the caller should
// gracefully skip the size step instead of guessing.
function loadShippingSizeMap() {
    try {
        const data = JSON.parse(fs.readFileSync(shippingFile(), 'utf-8'));
        const map = {};
        for (const opt of data.options || []) {
            if (opt.id && opt.packageSize) map[opt.id] = opt.packageSize;
        }
        return Object.keys(map).length ? map : null;
    } catch (e) { return null; }
}

// Pick the largest size needed to ship every saved carrier.
function packageSizeFor(shippingIds, sizeMap) {
    let best = null;
    for (const id of shippingIds) {
        const s = sizeMap[id];
        if (!s || !(s in SIZE_RANK)) continue;
        if (best === null || SIZE_RANK[s] > SIZE_RANK[best]) best = s;
    }
    return best;
}

// Build a { attrKey: { optionValue: label } } map from app/categories.json
// so we can translate stored option values like "pine" to the rendered label
// like "Kiefer". The same attrKey can appear under multiple categories with
// the same options, so a flat merged map is enough for our lookup needs.
let _CATEGORY_LABEL_MAP = null;
function loadCategoryLabelMap() {
    if (_CATEGORY_LABEL_MAP !== null) return _CATEGORY_LABEL_MAP;
    const map = {};
    try {
        const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'categories.json'), 'utf-8'));
        for (const schema of Object.values(data.attributeSchemas || {})) {
            for (const [attrKey, attr] of Object.entries(schema.attributes || {})) {
                const opts = (map[attrKey] ||= {});
                for (const o of attr.options || []) {
                    if (o && o.value && o.label) opts[o.value] = o.label;
                }
            }
        }
    } catch (e) {
        log(`[categories] failed to load: ${e.message}`);
    }
    _CATEGORY_LABEL_MAP = map;
    return map;
}

function labelForOption(attrKey, optionValue) {
    if (!attrKey || !optionValue) return null;
    const map = loadCategoryLabelMap();
    return map[attrKey]?.[optionValue] || null;
}

// Shared CDP connection. Reconnecting for every item is exactly where the
// "Requesting main frame too early!" race lives (puppeteer re-attaches to all
// targets while the freshly reloaded form page is still initializing), so we
// connect once and reuse the session across the whole batch.
let _browser = null;
async function connectToBrowser() {
    if (_browser && _browser.connected) return _browser;
    disconnectBrowser();
    const puppeteer = await getPuppeteer();
    const r = await fetch('http://127.0.0.1:9222/json/version');
    const d = await r.json();
    _browser = await puppeteer.connect({ browserWSEndpoint: d.webSocketDebuggerUrl, defaultViewport: null });
    log('[connect] new CDP connection established');
    return _browser;
}
function disconnectBrowser() {
    try { if (_browser) _browser.disconnect(); } catch (e) { /* ignore */ }
    _browser = null;
}

// Normalize a category label so suggestions ("A → B → C") match saved paths
// ("A > B > C") regardless of arrow style or spacing.
function normalizeCategoryLabel(s) {
    return String(s || '').replace(/[→›>»]/g, '>').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Resolve the exact click path through the manual category picker
// (/p-kategorie-aendern.html) using the bundled categories.json tree. The
// tree's node identifiers are the picker's anchor ids ("cat_<identifier>"),
// so no text matching is needed. The first levels are matched by name against
// the saved categoryPath; deeper levels (Art/Marke/Modell) are attribute-backed
// and matched by value against the item's saved dynamicFields — the tree's
// fieldName (e.g. "attributeMap[kleidung_herren.art_s]") says which attribute
// each level maps to.
function resolvePickerPath(categoryPath, dynamicFields = {}) {
    let tree;
    try {
        tree = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'categories.json'), 'utf-8')).tree;
    } catch (e) {
        return { error: `categories.json not readable: ${e.message}` };
    }
    const ids = [];
    let node = tree;
    for (const part of categoryPath.split('>').map(s => s.trim()).filter(Boolean)) {
        const want = normalizeCategoryLabel(part);
        const child = (node.children || []).find(c => normalizeCategoryLabel(c.name) === want);
        if (!child) return { error: `segment "${part}" not found under "${node.name}"` };
        ids.push(child.identifier);
        node = child;
    }
    // The picker requires drilling down to a leaf; each remaining level is an
    // attribute (Art, Marke, ...) whose value we already have in dynamicFields.
    while (node.children && node.children.length) {
        const m = String(node.children[0].fieldName || '').match(/^attributeMap\[(.+?)\]$/);
        if (!m) return { error: `categoryPath too short: "${node.name}" still has sub-categories` };
        const attrKey = m[1]; // e.g. "kleidung_herren.art_s"
        const value = dynamicFields[attrKey] ?? dynamicFields[attrKey.replace(/_s$/, '')];
        if (value == null) return { error: `no saved value for ${attrKey} (picker level "${node.childrenDescription || 'Art'}")` };
        const child = node.children.find(c => String(c.fieldValue) === String(value));
        if (!child) return { error: `value "${value}" not found for ${attrKey} under "${node.name}"` };
        ids.push(child.identifier);
        node = child;
    }
    return { ids };
}

async function selectCategory(page, categoryPath, dynamicFields = {}) {
    const want = normalizeCategoryLabel(categoryPath);
    const wantLeaf = want.split('>').pop().trim();
    // The first 2 levels are the actual Kleinanzeigen category; the 3rd level
    // is an `art_s` attribute that we set later via fillAttribute. So any
    // autosuggest matching the first 2 levels is acceptable — the leaf will
    // be corrected via attributeMap when we fill the form.
    const wantTrunk = want.split('>').slice(0, 2).map(s => s.trim()).join(' > ');

    // 1. Wait briefly for suggestions to appear (they animate in after typing).
    let suggestion = null;
    let sawSuggestions = false;
    for (let i = 0; i < 24; i++) {
        suggestion = await page.evaluate((want, wantLeaf, wantTrunk) => {
            const norm = (s) => String(s || '').replace(/[→›>»]/g, '>').replace(/\s+/g, ' ').trim().toLowerCase();
            const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
            // Collect all category-style labels first.
            const cats = [];
            for (const r of radios) {
                const lbl = r.closest('label') || document.querySelector(`label[for="${r.id}"]`);
                const text = norm(lbl ? lbl.textContent : '');
                if (text && text.includes('>')) cats.push({ r, text });
            }
            // 1a. Prefer an exact full-path match.
            for (const c of cats) {
                if (c.text === want) { c.r.click(); return { matched: 'full', text: c.text }; }
            }
            // 1b. Same trunk (parent > sub) — leaf differs but the underlying category id is identical.
            //     The leaf is set later via the art_s attribute, so this is safe.
            const trunkMatches = cats.filter(c => c.text.split('>').slice(0, 2).map(s => s.trim()).join(' > ') === wantTrunk);
            if (trunkMatches.length === 1) {
                trunkMatches[0].r.click();
                return { matched: 'trunk', text: trunkMatches[0].text };
            }
            // 1c. Otherwise, only accept a leaf match if the leaf is unique among
            //     the suggestions (otherwise we'd risk picking the wrong gender/branch).
            const leafMatches = cats.filter(c => c.text.split('>').pop().trim() === wantLeaf);
            if (leafMatches.length === 1) {
                leafMatches[0].r.click();
                return { matched: 'leaf', text: leafMatches[0].text };
            }
            return { matched: false, count: cats.length, all: cats.map(c => c.text) };
        }, want, wantLeaf, wantTrunk);
        if (suggestion && suggestion.matched) {
            log(`[category] suggestion matched (${suggestion.matched}): ${suggestion.text}`);
            await wait(300); return true;
        }
        if (suggestion && suggestion.count > 0) sawSuggestions = true;
        // If suggestions exist but none match, no point waiting more.
        if (sawSuggestions && i > 4) break;
        await wait(250);
    }
    if (suggestion && suggestion.count > 0 && !suggestion.matched) {
        log(`[category] suggestions present but none match (want="${want}", got=${JSON.stringify(suggestion.all || []).slice(0, 200)})`);
    } else if (!sawSuggestions) {
        log('[category] no suggestions appeared within 6s, falling back to manual picker');
    }

    // 2. No matching suggestion — use the manual picker deterministically.
    //    Resolve the click path from categories.json first, so we never rely
    //    on matching visible text on the picker page.
    const resolved = resolvePickerPath(categoryPath, dynamicFields);
    if (resolved.error) {
        log(`[category] cannot resolve picker path: ${resolved.error}`);
        return false;
    }
    log(`[category] no suggestion match, picker path: ${resolved.ids.map(id => 'cat_' + id).join(' / ')}`);

    //    The picker link's text depends on state: "Andere Kategorie wählen"
    //    when suggestions were shown, "Wähle deine Kategorie" when the title
    //    produced none. Prefer the anchor inside the suggestions container,
    //    then fall back to a text match for either label.
    const opened = await page.evaluate(() => {
        const scoped = document.querySelector('#ad-category-suggestions a');
        if (scoped) { scoped.click(); return true; }
        const links = Array.from(document.querySelectorAll('a, button'));
        const link = links.find(el => /andere kategorie|wähle deine kategorie|kategorie wählen/i.test(el.textContent || ''));
        if (link) { link.click(); return true; }
        return false;
    });
    if (!opened) { log('[category] could not open manual picker'); return false; }

    // Clicking the link triggers a full navigation to /p-kategorie-aendern.html.
    // Poll up to 30s for the picker columns (evaluate can throw mid-navigation);
    // if nothing happened after ~7s, re-click the link once — the first click
    // occasionally gets swallowed by the page's own scripts.
    let onPicker = false;
    for (let i = 0; i < 120 && !onPicker; i++) {
        onPicker = await page.evaluate(() => !!document.querySelector('.category-selection-list'))
            .catch(() => false);
        if (onPicker) break;
        if (i === 28) {
            log('[category] picker not loaded after 7s, re-clicking the link');
            await page.evaluate(() => {
                const scoped = document.querySelector('#ad-category-suggestions a');
                if (scoped) { scoped.click(); return; }
                const links = Array.from(document.querySelectorAll('a, button'));
                const link = links.find(el => /andere kategorie|wähle deine kategorie|kategorie wählen/i.test(el.textContent || ''));
                if (link) link.click();
            }).catch(() => {});
        }
        await wait(250);
    }
    if (!onPicker) { log('[category] picker page did not load'); return false; }

    // Click each level via its stable anchor id (e.g. #cat_153 → #cat_160 →
    // #cat_jacken_maentel). Each click renders the next column in-page (hash
    // navigation), so poll for the next anchor. If the same id ever appears in
    // two columns, the rightmost (last in DOM) is the one we want.
    for (const id of resolved.ids) {
        let clicked = false;
        for (let i = 0; i < 24 && !clicked; i++) {
            clicked = await page.evaluate((id) => {
                const els = document.querySelectorAll('[id="cat_' + id + '"]');
                const el = els[els.length - 1];
                if (!el) return false;
                el.scrollIntoView({ block: 'center' });
                el.click();
                return true;
            }, id).catch(() => false);
            if (!clicked) await wait(250);
        }
        if (!clicked) { log(`[category] picker: anchor cat_${id} never appeared`); return false; }
        log(`[category] picker: clicked cat_${id}`);
        await wait(300);
    }

    // Sanity check: the picker mirrors the selection into hidden form fields.
    const state = await page.evaluate(() => {
        const f = document.getElementById('postad-step1-frm');
        if (!f) return null;
        const val = (n) => { const el = f.querySelector('[name="' + n + '"]'); return el ? el.value : null; };
        return { parentCategoryId: val('parentCategoryId'), categoryId: val('categoryId') };
    }).catch(() => null);
    log(`[category] picker: form state ${JSON.stringify(state)}`);

    // Submit with "Weiter" — POSTs the step1 form back to the post-ad page.
    const submitted = await page.evaluate(() => {
        const btn = document.querySelector('#postad-step1-sbmt button')
            || document.querySelector('#postad-step1-frm button[type="submit"]');
        if (btn && !btn.disabled) { btn.click(); return true; }
        return false;
    }).catch(() => false);
    if (!submitted) { log('[category] picker: Weiter button not found'); return false; }
    log('[category] picker: clicked Weiter, waiting for the post-ad form');
    try {
        await page.waitForSelector('#ad-title', { visible: true, timeout: 15000 });
    } catch (e) {
        log('[category] picker: never returned to the post-ad form');
        return false;
    }
    log('[category] picker: back on form with category set');
    return true;
}

// Open the Versandmethoden dialog and select shipping options. The dialog
// has up to three sequential views:
//   1. "Empfehlung für dein Produkt" — recommended pair as checkboxes.
//      Confirms with [Bestätigen]. Switch to view 2 via "Andere Versandmethoden".
//   2. "Wähle eine andere Paketgröße aus." — SMALL/MEDIUM/LARGE radios.
//      Confirms with [Fertig], advancing to view 3 if a size is picked.
//   3. "Optionen mit Sendungsverfolgung" — carrier checkboxes for the picked size.
//      [Fertig] is disabled until at least one is checked.
//
// Strategy: always go via views 2 → 3 so we can pick exact carriers, regardless of
// what the recommendation view shows.
async function selectShippingSize(page, targetSize, wantedCarrierIds) {
    const visibleDialog = () => page.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const dialogs = Array.from(document.querySelectorAll('dialog')).filter(d => /Versandmethoden/i.test(d.querySelector('h2')?.textContent || ''));
        const d = dialogs.find(x => x.getBoundingClientRect().width > 0);
        if (!d) return null;
        const buttonTexts = Array.from(d.querySelectorAll('button')).map(b => norm(b.textContent));
        return {
            visible: true,
            hasSizeRadios: !!d.querySelector('input[type="radio"][value="SMALL"]'),
            hasSwitchLink: !!Array.from(d.querySelectorAll('button, a')).find(b => /andere versandmethoden/i.test(b.textContent || '')),
            checkboxValues: Array.from(d.querySelectorAll('input[type="checkbox"]')).map(c => c.value).filter(Boolean),
            buttonTexts,
        };
    });

    const before = await page.evaluate(() => {
        const btn = document.getElementById('ad-shipping-options');
        return { buttonExists: !!btn };
    });
    log(`[shipping] before click: ${JSON.stringify(before)}`);
    if (!before.buttonExists) return false;

    await page.evaluate(() => {
        const btn = document.getElementById('ad-shipping-options');
        if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); }
    });

    // Wait for dialog to appear.
    let state = null;
    for (let i = 0; i < 30 && !state; i++) {
        await wait(150);
        state = await visibleDialog();
    }
    if (!state) { log('[shipping] dialog never opened'); return false; }
    log(`[shipping] view 1: ${JSON.stringify(state)}`);

    // Switch from view 1 to view 2 via "Andere Versandmethoden".
    if (!state.hasSizeRadios) {
        if (!state.hasSwitchLink) { log('[shipping] view 1 has no "Andere Versandmethoden"'); return false; }
        await page.evaluate(() => {
            const d = Array.from(document.querySelectorAll('dialog')).filter(x => /Versandmethoden/i.test(x.querySelector('h2')?.textContent || '')).find(x => x.getBoundingClientRect().width > 0);
            const link = Array.from(d.querySelectorAll('button, a')).find(b => /andere versandmethoden/i.test(b.textContent || ''));
            if (link) link.click();
        });
        for (let i = 0; i < 20; i++) {
            await wait(150);
            state = await visibleDialog();
            if (state?.hasSizeRadios) break;
        }
        if (!state?.hasSizeRadios) { log('[shipping] view 2 (size picker) never appeared'); return false; }
        log(`[shipping] view 2: ${JSON.stringify(state)}`);
    }

    // Pick the size radio. Use the React-aware pattern: set checked via the
    // native prototype setter and dispatch input + change events. Plain .click()
    // and label-click don't reliably notify React-controlled inputs.
    const picked = await page.evaluate((size) => {
        const d = Array.from(document.querySelectorAll('dialog')).filter(x => /Versandmethoden/i.test(x.querySelector('h2')?.textContent || '')).find(x => x.getBoundingClientRect().width > 0);
        if (!d) return { ok: false, reason: 'dialog gone' };
        const radio = d.querySelector(`input[type="radio"][value="${size}"]`);
        if (!radio) return { ok: false, reason: 'no radio for ' + size };

        // 1. Programmatically check via the native setter so React's value tracker
        //    sees a real state change.
        const proto = Object.getPrototypeOf(radio);
        const setter = Object.getOwnPropertyDescriptor(proto, 'checked')?.set;
        if (setter) setter.call(radio, true); else radio.checked = true;
        radio.dispatchEvent(new Event('input', { bubbles: true }));
        radio.dispatchEvent(new Event('change', { bubbles: true }));

        // 2. Also click the label as a belt-and-suspenders signal (some
        //    React handlers attach to click on label rather than change).
        const lbl = Array.from(d.querySelectorAll('label')).find(l => l.getAttribute('for') === radio.id);
        if (lbl) lbl.click();

        return { ok: true, hadLabel: !!lbl, checkedAfter: radio.checked };
    }, targetSize);
    if (!picked.ok) { log(`[shipping] pick size failed: ${picked.reason}`); return false; }
    log(`[shipping] size picked: ${JSON.stringify(picked)}`);

    // After picking a size in view 2, the dialog stays in view 2 but the
    // primary button switches from "Fertig" to "Weiter". Click it to advance
    // to view 3 (carriers).
    await wait(200);
    const advance = await page.evaluate(() => {
        const d = Array.from(document.querySelectorAll('dialog')).filter(x => /Versandmethoden/i.test(x.querySelector('h2')?.textContent || '')).find(x => x.getBoundingClientRect().width > 0);
        const btn = Array.from(d?.querySelectorAll('button') || []).find(b => /^(weiter|fertig)$/i.test((b.textContent || '').trim()) && !b.disabled);
        if (!btn) return { ok: false };
        btn.click();
        return { ok: true, label: btn.textContent.trim() };
    });
    if (!advance.ok) {
        log('[shipping] no Weiter/Fertig button in view 2 after size pick');
        return false;
    }
    log(`[shipping] advanced via ${advance.label}`);

    // Wait for view 3 (carrier checkboxes for the chosen size).
    let view3 = null;
    for (let i = 0; i < 25 && !view3; i++) {
        await wait(150);
        view3 = await page.evaluate(() => {
            const d = Array.from(document.querySelectorAll('dialog')).filter(x => /Versandmethoden/i.test(x.querySelector('h2')?.textContent || '')).find(x => x.getBoundingClientRect().width > 0);
            if (!d) return null;
            const carriers = Array.from(d.querySelectorAll('input[type="checkbox"]')).map(c => c.value).filter(v => /^[A-Z]+_\d+$/.test(v));
            if (!carriers.length) return null;
            return { carriers };
        });
    }
    if (!view3) { log('[shipping] view 3 (carriers) never appeared'); return false; }
    log(`[shipping] view 3: ${JSON.stringify(view3)}`);

    // Tick wanted carriers, untick the rest. Done one click at a time, with
    // re-querying between clicks, because each click may trigger a React
    // re-render that invalidates previously captured element references.
    const carrierIds = view3.carriers;
    let ticked = 0;
    for (const id of carrierIds) {
        const want = wantedCarrierIds.includes(id);
        // Re-query state for this specific checkbox each time.
        const action = await page.evaluate((id) => {
            const d = Array.from(document.querySelectorAll('dialog')).filter(x => /Versandmethoden/i.test(x.querySelector('h2')?.textContent || '')).find(x => x.getBoundingClientRect().width > 0);
            const cb = d?.querySelector(`input[type="checkbox"][value="${id}"]`);
            if (!cb) return { found: false };
            return { found: true, checked: cb.checked, cbId: cb.id };
        }, id);
        if (!action.found) {
            log(`[shipping] carrier ${id} not in dialog`);
            continue;
        }
        if (action.checked === want) {
            if (want) ticked++;
            continue;
        }
        // Click the label (real ID lookup, not CSS selector — IDs contain ":")
        const clicked = await page.evaluate((id) => {
            const d = Array.from(document.querySelectorAll('dialog')).filter(x => /Versandmethoden/i.test(x.querySelector('h2')?.textContent || '')).find(x => x.getBoundingClientRect().width > 0);
            const cb = d?.querySelector(`input[type="checkbox"][value="${id}"]`);
            if (!cb) return false;
            const lbl = Array.from(d.querySelectorAll('label')).find(l => l.getAttribute('for') === cb.id);
            (lbl || cb).click();
            return true;
        }, id);
        if (!clicked) continue;
        await wait(150);
        if (want) ticked++;
    }
    log(`[shipping] ticked carriers: ${ticked}/${wantedCarrierIds.length}`);
    if (ticked === 0) { log('[shipping] no wanted carriers ticked'); return false; }

    // Wait for at least one carrier checkbox to be checked, then click Fertig.
    for (let i = 0; i < 15; i++) {
        await wait(100);
        const ready = await page.evaluate(() => {
            const d = Array.from(document.querySelectorAll('dialog')).filter(x => /Versandmethoden/i.test(x.querySelector('h2')?.textContent || '')).find(x => x.getBoundingClientRect().width > 0);
            if (!d) return false;
            const checked = Array.from(d.querySelectorAll('input[type="checkbox"]')).some(c => /^[A-Z]+_\d+$/.test(c.value) && c.checked);
            const btn = Array.from(d.querySelectorAll('button')).find(b => /^fertig$/i.test((b.textContent || '').trim()));
            return checked && btn && !btn.disabled;
        });
        if (ready) break;
    }

    const confirmed = await page.evaluate(() => {
        const d = Array.from(document.querySelectorAll('dialog')).filter(x => /Versandmethoden/i.test(x.querySelector('h2')?.textContent || '')).find(x => x.getBoundingClientRect().width > 0);
        if (!d) return false;
        const btn = Array.from(d.querySelectorAll('button')).find(b => /^fertig$/i.test((b.textContent || '').trim()) && !b.disabled);
        if (!btn) return false;
        btn.click();
        return true;
    });
    if (!confirmed) { log('[shipping] could not click final Fertig'); return false; }
    await wait(500);
    log(`[shipping] selected size=${targetSize} carriers=${JSON.stringify(wantedCarrierIds)}`);
    return true;
}

// Read the size currently implied by the form's pre-selected carrier IDs.
async function readCurrentShippingSize(page, sizeMap) {
    return page.evaluate((map) => {
        const ids = ['shippingOptions[0].id', 'shippingOptions[1].id']
            .map(n => document.querySelector(`input[name="${n}"]`)?.value)
            .filter(Boolean);
        const order = { SMALL: 0, MEDIUM: 1, LARGE: 2 };
        return ids
            .map(id => map[id])
            .filter(Boolean)
            .reduce((best, s) => (best === null || order[s] > order[best] ? s : best), null);
    }, sizeMap);
}

async function applyShipping(page, savedShippingIds) {
    if (!Array.isArray(savedShippingIds) || savedShippingIds.length === 0) return;
    const sizeMap = loadShippingSizeMap();
    if (!sizeMap) {
        log('[shipping] shipping-options.json missing or empty — run 🔄 in the UI to refresh. Skipping size step.');
        return;
    }
    const targetSize = packageSizeFor(savedShippingIds, sizeMap);
    if (!targetSize) {
        log(`[shipping] no recognized IDs in ${JSON.stringify(savedShippingIds)}, leaving page defaults`);
        return;
    }
    const currentSize = await readCurrentShippingSize(page, sizeMap);
    log(`[shipping] currentSize=${currentSize} targetSize=${targetSize}`);
    if (currentSize === targetSize) {
        log('[shipping] already at target size, skipping dialog');
        return;
    }
    await selectShippingSize(page, targetSize, savedShippingIds);
}

// "Individueller Versand": user pays own shipping, optionally with custom cost.
// Open the dialog → switch to view 2 → tick the INDIVIDUAL checkbox → optionally
// fill the cost → click Fertig.
async function applyIndividualShipping(page, customCostInEuros) {
    const opened = await page.evaluate(() => {
        const btn = document.getElementById('ad-shipping-options');
        if (!btn) return false;
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        return true;
    });
    if (!opened) { log('[shipping] could not open dialog (individual)'); return false; }

    // Wait for dialog → switch to view 2 if needed.
    const dialogState = async () => page.evaluate(() => {
        const d = Array.from(document.querySelectorAll('dialog')).filter(x => /Versandmethoden/i.test(x.querySelector('h2')?.textContent || '')).find(x => x.getBoundingClientRect().width > 0);
        if (!d) return null;
        const hasIndividual = !!d.querySelector('input[type="checkbox"][value="INDIVIDUAL"]');
        const hasSwitchLink = !!Array.from(d.querySelectorAll('button, a')).find(b => /andere versandmethoden/i.test(b.textContent || ''));
        return { hasIndividual, hasSwitchLink };
    });
    let state = null;
    for (let i = 0; i < 30 && !state; i++) { await wait(150); state = await dialogState(); }
    if (!state) { log('[shipping] dialog never opened (individual)'); return false; }
    if (!state.hasIndividual && state.hasSwitchLink) {
        await page.evaluate(() => {
            const d = Array.from(document.querySelectorAll('dialog')).filter(x => /Versandmethoden/i.test(x.querySelector('h2')?.textContent || '')).find(x => x.getBoundingClientRect().width > 0);
            const link = Array.from(d.querySelectorAll('button, a')).find(b => /andere versandmethoden/i.test(b.textContent || ''));
            link && link.click();
        });
        for (let i = 0; i < 20; i++) { await wait(150); state = await dialogState(); if (state?.hasIndividual) break; }
    }
    if (!state?.hasIndividual) { log('[shipping] INDIVIDUAL checkbox not found'); return false; }

    // Tick the INDIVIDUAL checkbox. Kleinanzeigen wraps it in a label with
    // `for="<id>"` where the id contains ":" (so CSS selectors break). Also
    // the React component listens to label clicks, not to programmatic
    // .checked assignment. The most reliable approach is to find the label
    // by attribute and dispatch a real puppeteer click on it.
    const tickResult = await page.evaluate(() => {
        const d = Array.from(document.querySelectorAll('dialog')).filter(x => /Versandmethoden/i.test(x.querySelector('h2')?.textContent || '')).find(x => x.getBoundingClientRect().width > 0);
        const cb = d?.querySelector('input[type="checkbox"][value="INDIVIDUAL"]');
        if (!cb) return { ok: false, reason: 'no INDIVIDUAL checkbox' };
        const wasChecked = cb.checked;
        const lbl = Array.from(d.querySelectorAll('label')).find(l => l.getAttribute('for') === cb.id);
        // Clicking the label fires native input click → React's onChange.
        if (lbl) lbl.click(); else cb.click();
        return { ok: true, wasChecked, hadLabel: !!lbl, cbId: cb.id, checkedAfter: cb.checked };
    });
    log(`[shipping] tick INDIVIDUAL: ${JSON.stringify(tickResult)}`);
    if (!tickResult.ok) return false;

    // Wait for INDIVIDUAL to be checked AND the cost input to be enabled.
    let inputReady = false;
    for (let i = 0; i < 20 && !inputReady; i++) {
        await wait(150);
        inputReady = await page.evaluate(() => {
            const cb = document.querySelector('dialog input[type="checkbox"][value="INDIVIDUAL"]');
            const inp = document.getElementById('ad-individual-shipping-price');
            return !!cb?.checked && !!inp && !inp.disabled && !inp.readOnly;
        });
    }
    if (!inputReady) log('[shipping] INDIVIDUAL did not become ready (cost input may be disabled)');

    // Fill the cost field. Use real keyboard typing via puppeteer so React's
    // controlled-input tracker accepts the value.
    if (customCostInEuros) {
        // Kleinanzeigen accepts comma-decimal (German). Use the user's string as-is.
        const costStr = String(customCostInEuros).trim();
        try {
            await page.click('#ad-individual-shipping-price', { clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.keyboard.type(costStr, { delay: 30 });
            await wait(200);
        } catch (e) { log(`[shipping] cost field type failed: ${e.message}`); }
    }

    // Wait for Fertig to be clickable, then click it.
    for (let i = 0; i < 15; i++) {
        await wait(100);
        const ok = await page.evaluate(() => {
            const d = Array.from(document.querySelectorAll('dialog')).filter(x => /Versandmethoden/i.test(x.querySelector('h2')?.textContent || '')).find(x => x.getBoundingClientRect().width > 0);
            const btn = Array.from(d?.querySelectorAll('button') || []).find(b => /^fertig$/i.test((b.textContent || '').trim()));
            return btn && !btn.disabled;
        });
        if (ok) break;
    }
    const confirmed = await page.evaluate(() => {
        const d = Array.from(document.querySelectorAll('dialog')).filter(x => /Versandmethoden/i.test(x.querySelector('h2')?.textContent || '')).find(x => x.getBoundingClientRect().width > 0);
        const btn = Array.from(d?.querySelectorAll('button') || []).find(b => /^fertig$/i.test((b.textContent || '').trim()) && !b.disabled);
        if (!btn) return false;
        btn.click();
        return true;
    });
    if (!confirmed) { log('[shipping] could not click Fertig (individual)'); return false; }
    await wait(500);
    log(`[shipping] selected Individueller Versand cost=${customCostInEuros || ''}`);
    return true;
}

// Set the shipping-enabled radio (Versand möglich / Nur Abholung).
async function setShippingEnabled(page, enable) {
    await page.evaluate((wantOn) => {
        const id = wantOn ? 'ad-shipping-enabled-yes' : 'ad-shipping-enabled-no';
        const r = document.getElementById(id);
        if (!r) return;
        r.click();
        const lbl = document.querySelector(`label[for="${id}"]`);
        if (lbl) lbl.click();
    }, enable);
    await wait(400);
}

async function selectComboboxOption(page, btnSel, text) {
    if (!text) return false;
    try {
        await page.waitForSelector(btnSel, { visible: true, timeout: 3000 });
        await page.click(btnSel); await wait(400);
        const ok = await page.evaluate((t) => {
            for (const o of document.querySelectorAll('[role="option"]')) if (o.textContent.trim() === t) { o.click(); return true; }
            return false;
        }, text);
        if (!ok) await page.keyboard.press('Escape');
        await wait(300); return ok;
    } catch (e) { return false; }
}

async function runSingleItem(itemPath, opts = {}) {
    const submit = !!opts.submit;
    const dataPath = path.join(itemPath, 'data.json');
    if (!fs.existsSync(dataPath)) throw new Error('data.json not found in ' + itemPath);
    const adData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

    let photoFiles;
    if (adData.photoOrder && adData.photoOrder.length > 0) {
        photoFiles = adData.photoOrder.filter(f => fs.existsSync(path.join(itemPath, f))).map(f => path.join(itemPath, f));
    } else {
        photoFiles = fs.readdirSync(itemPath).filter(f => IMAGE_EXTS.includes(path.extname(f).toLowerCase())).sort().map(f => path.join(itemPath, f));
    }

    const browser = await connectToBrowser();
    try {
        // Find the tab with the post-ad form. Right after connecting, pages
        // can be mid-navigation or not yet hydrated — puppeteer then throws
        // "Requesting main frame too early!" even from p.url(). So guard every
        // per-page call and retry the whole scan a few times.
        let page = null;
        let fallback = null; // any kleinanzeigen tab, in case the form isn't open
        for (let attempt = 0; attempt < 4 && !page; attempt++) {
            if (attempt > 0) await wait(1500);
            let pages = [];
            try { pages = await browser.pages(); } catch (e) { log(`[connect] browser.pages() failed: ${e.message}`); continue; }
            for (const p of pages) {
                try {
                    if (!p.url().includes('kleinanzeigen.de')) continue;
                    fallback = fallback || p;
                    await p.waitForSelector(SELECTORS.title, { visible: true, timeout: 1500 });
                    page = p; break;
                } catch (e) { /* tab mid-navigation or no form — skip */ }
            }
        }
        if (!page && fallback) {
            // A kleinanzeigen tab exists but isn't on the form (e.g. stuck on
            // the confirmation page) — steer it back to the form ourselves.
            log('[connect] no form tab found, navigating a kleinanzeigen tab to the post-ad form');
            try {
                await fallback.goto(POST_FORM_URL, { waitUntil: 'domcontentloaded' });
                await fallback.waitForSelector(SELECTORS.title, { visible: true, timeout: 15000 });
                page = fallback;
            } catch (e) { log(`[connect] fallback navigation failed: ${e.message}`); }
        }
        if (!page) throw new Error('Could not find Kleinanzeigen form page');
        await page.bringToFront();
        await page.waitForSelector(SELECTORS.title, { visible: true, timeout: 15000 });

        // Type into a (possibly React-controlled) input and VERIFY the result.
        // Fields like the ZIP trigger async lookups while typing; a re-render
        // mid-typing can drop or duplicate keystrokes (e.g. 44141 → 44441).
        // So: clear via the React-aware value setter, type with a small delay,
        // then read the value back and retry slower on mismatch.
        const typeInField = async (sel, text) => {
            if (!text) return;
            const want = String(text);
            await page.waitForSelector(sel, { visible: true, timeout: 5000 });
            for (let attempt = 0; attempt < 3; attempt++) {
                await page.evaluate((s) => {
                    const el = document.querySelector(s);
                    if (!el) return;
                    el.focus();
                    const proto = Object.getPrototypeOf(el);
                    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                    if (setter) setter.call(el, ''); else el.value = '';
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                }, sel);
                await page.type(sel, want, { delay: attempt === 0 ? 20 : 80 });
                await wait(300);
                const got = await page.evaluate((s) => { const el = document.querySelector(s); return el ? el.value : null; }, sel);
                if (got === want) return;
                log(`[typeInField] ${sel}: got "${got}", want "${want}" — retrying slower (attempt ${attempt + 1})`);
            }
            throw new Error(`typeInField: ${sel} would not accept "${want}"`);
        };
        const resolveAttr = (key) => key.replace(/_s$/, '');
        const fillAttribute = async (attrName, value, autocompleteLabels = {}) => {
            const info = await page.evaluate((name) => {
                // Some attributes ship with an `_s` (string-typed) suffix on the form
                // even though we strip it off our saved keys. Try both names.
                const tryNames = [name, name + '_s'];
                let h = null, resolvedName = name;
                for (const n of tryNames) {
                    h = document.querySelector(`input[name="attributeMap[${n}]"]`);
                    if (h) { resolvedName = n; break; }
                }
                if (!h) return null;
                // The visible control may be keyed by either the bare name or the _s name.
                const el = document.getElementById(name) || document.getElementById(resolvedName);
                const usedId = el ? el.id : null;
                // No element with this ID? Look for a sibling/related dialog-trigger button.
                if (!el) {
                    let node = h;
                    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
                        const btn = node.querySelector && node.querySelector('button[aria-haspopup="dialog"]');
                        if (btn) {
                            const handle = '__auto_dialog_' + resolvedName.replace(/\W+/g, '_');
                            btn.setAttribute('data-auto-handle', handle);
                            return { type: 'dialog', handle, resolvedName };
                        }
                    }
                    return { type: 'hidden-only', resolvedName };
                }
                const tag = el.tagName.toLowerCase(), role = el.getAttribute('role') || '', hp = el.getAttribute('aria-haspopup') || '';
                if (tag === 'button' && hp === 'dialog') return { type: 'dialog', id: usedId, resolvedName };
                if (tag === 'button' && role === 'combobox') return { type: 'combobox', id: usedId, resolvedName };
                if (tag === 'input' && role === 'combobox') return { type: 'autocomplete', id: usedId, resolvedName };
                if (tag === 'input') return { type: 'input', id: usedId, resolvedName };
                if (tag === 'select') return { type: 'select', id: usedId, resolvedName };
                return { type: 'unknown', tag, role, hp, resolvedName };
            }, attrName);
            log(`[fillAttribute] attr=${attrName} value=${JSON.stringify(value)} info=${JSON.stringify(info)}`);
            if (!info) return false;
            const eid = (info.id || '').replace(/\./g, '\\.');
            switch (info.type) {
                case 'combobox': {
                    await page.click(`#${eid}`); await wait(300);
                    const label = labelForOption(attrName, value);
                    const s = await page.evaluate((v, lbl) => {
                        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
                        const targetVal = String(v || '');
                        const targetLbl = lbl ? norm(lbl) : null;
                        for (const o of document.querySelectorAll('[role="option"]')) {
                            const dv = o.getAttribute('data-value') || '';
                            const txt = norm(o.textContent);
                            if (dv === targetVal) { o.click(); return true; }
                            if (txt === norm(targetVal)) { o.click(); return true; }
                            if (targetLbl && txt === targetLbl) { o.click(); return true; }
                        }
                        return false;
                    }, value, label);
                    if (!s) await page.keyboard.press('Escape'); await wait(200); return s;
                }
                case 'dialog': {
                    const triggerSel = info.handle ? `[data-auto-handle="${info.handle}"]` : `#${eid}`;
                    await page.click(triggerSel); await wait(600);
                    return await page.evaluate((v) => {
                        // Find the visible modal dialog
                        const dialogs = Array.from(document.querySelectorAll('dialog[open], [role="dialog"]'));
                        const d = dialogs.find(x => x.offsetParent !== null) || dialogs[0];
                        if (!d) return false;
                        let clicked = false;
                        for (const r of d.querySelectorAll('input[type="radio"]')) {
                            if (r.value === v) {
                                // Native click on the input fires React's onChange
                                r.click();
                                // Look up the wrapping label by attribute (ids may contain ":").
                                const lbl = Array.from(d.querySelectorAll('label')).find(l => l.getAttribute('for') === r.id);
                                if (lbl) lbl.click();
                                clicked = true;
                                break;
                            }
                        }
                        if (!clicked) return false;
                        const btns = Array.from(d.querySelectorAll('button'));
                        const confirm = btns.find(b => /(bestätigen|übernehmen|fertig|ok)/i.test((b.textContent || '').trim()));
                        if (confirm) { confirm.click(); return true; }
                        return clicked;
                    }, value);
                }
                case 'autocomplete': {
                    // For autocomplete, prefer a human-readable label if we have one.
                    let label = value;
                    if (autocompleteLabels) {
                        const k = Object.keys(autocompleteLabels).find(k =>
                            k === info.id + '-input' ||
                            k.replace(/-input$/, '') === info.id ||
                            info.id.endsWith('.' + k.replace(/-input$/, ''))
                        );
                        if (k) label = autocompleteLabels[k];
                        else if (Object.keys(autocompleteLabels).length === 1) {
                            label = Object.values(autocompleteLabels)[0];
                        }
                    }

                    // 1. Focus and aggressively clear via keystrokes (so React
                    //    sees the input transition through "" and re-renders).
                    await page.click(`#${eid}`, { clickCount: 3 });
                    await page.keyboard.press('Backspace');
                    await wait(200);
                    // Belt-and-suspenders: also use the React-aware setter and dispatch input.
                    await page.evaluate((s) => {
                        const el = document.querySelector(s);
                        if (!el) return;
                        const proto = Object.getPrototypeOf(el);
                        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                        if (setter) setter.call(el, ''); else el.value = '';
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                    }, `#${eid}`);
                    await wait(200);

                    // 2. Type one char at a time, dispatching input events explicitly,
                    //    and wait for the option list to appear after each char.
                    const seen = [];
                    let optionFound = false;
                    for (let i = 0; i < label.length; i++) {
                        await page.keyboard.type(label[i], { delay: 0 });
                        // Wait briefly between chars so async filtering can keep up
                        await wait(80);
                    }

                    // 3. Poll up to 3s for matching option to appear.
                    for (let i = 0; i < 30; i++) {
                        await wait(100);
                        const result = await page.evaluate((v) => {
                            const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
                            const target = norm(v);
                            const opts = Array.from(document.querySelectorAll('[role="option"]'));
                            const labels = opts.map(o => (o.textContent || '').trim());
                            if (opts.length === 0) return { state: 'empty', labels };
                            for (const o of opts) {
                                if (norm(o.textContent) === target) { o.click(); return { state: 'matched', labels }; }
                            }
                            for (const o of opts) {
                                if (norm(o.textContent).startsWith(target)) { o.click(); return { state: 'startsWith', labels }; }
                            }
                            return { state: 'noMatch', labels };
                        }, label);
                        seen.push(result);
                        if (result.state === 'matched' || result.state === 'startsWith') { optionFound = true; break; }
                        // If options are rendered and don't match for 4 consecutive polls, stop.
                        if (result.state === 'noMatch' && seen.filter(s => s.state === 'noMatch').length >= 4) break;
                    }

                    if (!optionFound) {
                        // Diagnostic log so we can see what the page actually returned.
                        const last = seen[seen.length - 1] || {};
                        const sample = (last.labels || []).slice(0, 12);
                        log(`[autocomplete] '${label}' for #${info.id} not matched. State=${last.state}. Visible options: ${JSON.stringify(sample)}`);
                        // As a fallback, accept the first suggestion (better than landing on "Sonstige").
                        await page.keyboard.press('ArrowDown');
                        await page.keyboard.press('Enter');
                    } else {
                        log(`[autocomplete] '${label}' for #${info.id} matched.`);
                    }
                    await wait(300);
                    return optionFound;
                }
                case 'select': await page.select(`#${eid}`, value); return true;
                case 'input': await typeInField(`#${eid}`, value); return true;
                default: return false;
            }
        };

        await typeInField(SELECTORS.title, adData.title);

        // Category selection: typing the title triggers either a small list
        // of suggested categories (radio buttons) or nothing. Pick the one
        // matching the saved categoryPath; otherwise drill through the manual
        // picker deterministically. The picker's deeper levels (Art/Marke/...)
        // are attribute-backed, so pass the saved dynamicFields along.
        if (adData.categoryPath) {
            try {
                const ok = await selectCategory(page, adData.categoryPath, adData.dynamicFields || {});
                if (!ok) log('[category] selection failed — the ad will be missing its category');
            }
            catch (e) { console.warn('Category selection failed:', e.message); }
        }

        if (adData.description) {
            await page.waitForSelector(SELECTORS.description, { visible: true });
            await page.click(SELECTORS.description);
            await page.evaluate((s) => { document.querySelector(s).value = ''; }, SELECTORS.description);
            await page.type(SELECTORS.description, adData.description);
        }
        await typeInField(SELECTORS.price, adData.price);
        if (adData.priceType) {
            const labels = { 'FIXED': 'Festpreis', 'NEGOTIABLE': 'VB', 'GIVE_AWAY': 'Zu verschenken' };
            await selectComboboxOption(page, SELECTORS.priceType, labels[adData.priceType] || adData.priceType);
        }

        // Direkt kaufen (buy-now). Only present for FIXED-price items in eligible
        // categories, and only when price <= 1000 €. We click the matching radio
        // if present; if not, we silently move on.
        if (adData.priceType === 'FIXED' && typeof adData.buyNow === 'boolean') {
            try {
                await page.evaluate((wantBuyNow) => {
                    const id = wantBuyNow ? 'ad-buy-now-true' : 'ad-buy-now-false';
                    const r = document.getElementById(id);
                    if (r) {
                        r.click();
                        const lbl = document.querySelector(`label[for="${id}"]`);
                        if (lbl) lbl.click();
                    }
                }, adData.buyNow);
                await wait(200);
            } catch (e) {}
        }

        const attrs = {};
        // Dynamic fields (option IDs like "tommy_hilfiger") are good for select/dialog/option lookups.
        if (adData.dynamicFields) for (const [k, v] of Object.entries(adData.dynamicFields)) attrs[resolveAttr(k)] = v;
        // Autocomplete labels (human text like "Tommy Hilfiger") override the ID for the same attr —
        // free-text autocomplete inputs need the label to match a suggestion.
        const autocompleteLabels = {};
        if (adData.autocompleteFields) {
            for (const [k, v] of Object.entries(adData.autocompleteFields)) {
                // "brands-input" -> brand attribute key. We don't always know the mapping, so also
                // expose a generic flag the autocomplete branch can pick up by id suffix.
                autocompleteLabels[k] = v;
            }
        }
        if (adData.condition) {
            const ca = await page.evaluate(() => { const e = document.querySelector('input[name*=".condition"]'); const m = e && e.name.match(/attributeMap\[(.+)\]/); return m ? m[1] : null; });
            if (ca) attrs[ca] = adData.condition;
        }
        // The .versand attribute is handled below by the dedicated Versand step.
        // (We keep .art_s — Kleinanzeigen guesses it from the title, but we want
        // the user's explicit choice. fillAttribute will set it on the form.)
        for (const k of Object.keys(attrs)) {
            if (/\.versand$/.test(k) || /\.versand_s$/.test(k)) delete attrs[k];
        }
        log(`[attrs] item=${path.basename(itemPath)} keys=${JSON.stringify(Object.keys(attrs))} autocompleteLabels=${JSON.stringify(autocompleteLabels)}`);
        for (const [k, v] of Object.entries(attrs)) {
            try { await fillAttribute(k, v, autocompleteLabels); }
            catch (e) { log(`[attrs] error filling ${k}=${v}: ${e.message}`); }
        }

        // Versand: toggle the radio, then if shipping is enabled and we have
        // saved carriers (or an Individueller Versand selection), apply it.
        try {
            const mode = adData.versandMode
                || (adData.shippingOptions?.length > 0 ? 'ja'
                    : adData.customShippingCost ? 'custom'
                    : 'nein');
            const wantShip = mode !== 'nein';
            await setShippingEnabled(page, wantShip);
            if (mode === 'ja') await applyShipping(page, adData.shippingOptions);
            else if (mode === 'custom') await applyIndividualShipping(page, adData.customShippingCost);
        } catch (e) { log(`[shipping] step failed: ${e.message}`); }

        if (adData.zipCode) {
            await typeInField(SELECTORS.zipCode, adData.zipCode); await wait(1500);
            const targetCity = adData.city || 'Dortmund - Mitte';
            const current = await page.evaluate(() => { const e = document.getElementById('ad-city-selected-option'); return e ? e.textContent.trim() : ''; });
            if (current !== targetCity) await selectComboboxOption(page, '#ad-city', targetCity);
        }

        if (photoFiles.length > 0) {
            const fi = await page.$(SELECTORS.photoUploadInput);
            if (fi) {
                await fi.uploadFile(...photoFiles);
                // Poll for upload completion: each successfully uploaded image
                // adds a thumbnail with a "img.kleinanzeigen.de" src to the
                // photo grid. Wait up to 60s, checking every 500ms.
                const expected = photoFiles.length;
                let actual = 0;
                for (let i = 0; i < 120; i++) {
                    await wait(500);
                    actual = await page.evaluate(() => {
                        return document.querySelectorAll('img[src*="img.kleinanzeigen.de"][alt*="Anzeige"], img[src*="img.kleinanzeigen.de"][alt*="Bild"]').length;
                    });
                    if (actual >= expected) break;
                }
                log(`[photos] uploaded ${actual}/${expected}`);
            }
        }

        if (submit) {
            await submitAd(page, itemPath);
        }
    } catch (e) {
        // A failed run may leave the CDP session in a bad state — drop the
        // shared connection so the next item reconnects fresh.
        disconnectBrowser();
        throw e;
    }
    // On success, keep the connection alive for the next item in the batch.
}

const POST_FORM_URL = 'https://www.kleinanzeigen.de/p-anzeige-aufgeben-schritt2.html';

// Click "Anzeige aufgeben", wait for the page to navigate away from the form,
// then bring the page back to the form so the next item starts fresh.
async function submitAd(page, itemPath) {
    log('[submit] clicking Anzeige aufgeben');
    const clicked = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button'))
            .find(b => /^anzeige aufgeben$/i.test((b.textContent || '').trim()));
        if (!btn) return false;
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        return true;
    });
    if (!clicked) throw new Error('submit button "Anzeige aufgeben" not found');

    // Wait up to 60s for the page URL to leave the post-ad form. If it stays
    // on the form with a validation error, throw so the batch can stop.
    const startUrl = page.url();
    let landed = null;
    for (let i = 0; i < 120; i++) {
        await wait(500);
        const url = page.url();
        if (!url.includes('p-anzeige-aufgeben-schritt2')) { landed = url; break; }
    }
    if (!landed) {
        // Still on the form. Try to capture the error message for diagnostics.
        const err = await page.evaluate(() => {
            const al = document.querySelector('[role="alert"], .error, .text-critical, [class*="error"]');
            return al ? (al.textContent || '').trim().slice(0, 300) : null;
        });
        throw new Error('submit did not navigate (form validation likely failed): ' + (err || 'no visible error'));
    }
    // Navigating away is not enough: if the category was missing, the site
    // redirects to the category picker instead of the confirmation page —
    // that means the ad was NOT posted and must not be marked as such.
    if (landed.includes('p-kategorie-aendern')) {
        log(`[submit] FAILED — redirected to category picker (category was not set): ${landed}`);
        throw new Error('submit rejected: category was not set (redirected to p-kategorie-aendern)');
    }
    if (!landed.includes('bestaetigung')) {
        log(`[submit] warning: landed on unexpected page ${landed}`);
    }
    log(`[submit] success, landed on ${landed}`);

    // Navigate back to the form for the next item.
    await page.goto(POST_FORM_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(SELECTORS.title, { visible: true, timeout: 15000 });
    log('[submit] form ready for next item');
}

module.exports = { runSingleItem, log, disconnectBrowser };
