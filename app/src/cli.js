#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const APP_ROOT = path.join(__dirname, '..');
const PROJECT_ROOT = path.join(APP_ROOT, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];

const wait = (ms) => new Promise(r => setTimeout(r, ms));

const SELECTORS = {
    title: '#ad-title', description: '#ad-description', price: '#ad-price-amount',
    priceType: '#ad-price-type', zipCode: '#ad-zip-code', street: '#ad-street',
    city: '#ad-city', photoUploadInput: 'input[type="file"][accept*="image"]',
};

function ask(q) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(r => rl.question(q, a => { rl.close(); r(a.trim()); }));
}

function getProjectFolder() {
    try {
        const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        if (c.projectFolder && fs.existsSync(c.projectFolder)) return c.projectFolder;
    } catch (e) {}
    return null;
}

function listTemplates(folder) {
    return fs.readdirSync(folder, { withFileTypes: true })
        .filter(d => d.isDirectory() && !['node_modules', '.git', '.thumbs'].includes(d.name))
        .map(d => d.name).sort();
}

function loadTemplate(folder, name) {
    const dir = path.join(folder, name);
    const dp = path.join(dir, 'data.json');
    let data = {};
    try { data = JSON.parse(fs.readFileSync(dp, 'utf-8')); } catch (e) {}
    let photos;
    if (data.photoOrder && data.photoOrder.length > 0) {
        photos = data.photoOrder.filter(f => fs.existsSync(path.join(dir, f))).map(f => path.join(dir, f));
    } else {
        photos = fs.readdirSync(dir).filter(f => IMAGE_EXTS.includes(path.extname(f).toLowerCase())).sort().map(f => path.join(dir, f));
    }
    return { data, photos, dir };
}

async function connectToBrowser() {
    const puppeteer = (await import('puppeteer')).default; // ESM-only since v25
    const r = await fetch('http://127.0.0.1:9222/json/version');
    const d = await r.json();
    return puppeteer.connect({ browserWSEndpoint: d.webSocketDebuggerUrl, defaultViewport: null });
}

async function findAdPage(browser) {
    const pages = await browser.pages();
    for (const p of pages) {
        try { await p.waitForSelector(SELECTORS.title, { visible: true, timeout: 1500 }); return p; } catch (e) {}
    }
    return null;
}

async function selectComboboxOption(page, btnSel, text) {
    if (!text) return false;
    try {
        await page.waitForSelector(btnSel, { visible: true, timeout: 3000 });
        await page.click(btnSel); await wait(400);
        const ok = await page.evaluate((t) => {
            for (const o of document.querySelectorAll('[role="option"]'))
                if (o.textContent.trim() === t) { o.click(); return true; }
            return false;
        }, text);
        if (!ok) await page.keyboard.press('Escape');
        await wait(300); return ok;
    } catch (e) { return false; }
}

async function selectCategory(page, categoryPath) {
    if (!categoryPath) return;
    const parts = categoryPath.split('>').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return;

    // Check if we're on the form page and category is empty — need to open category selector
    const needsNav = await page.evaluate(() => {
        const catBtn = document.querySelector('[data-testid="category-selection-button"]') ||
                       document.querySelector('button[class*="category"]');
        if (catBtn && (catBtn.textContent.includes('Wähle') || catBtn.textContent.includes('Kategorie'))) return true;
        return false;
    });

    if (needsNav) {
        // Click the category button to navigate to category selection page
        await page.evaluate(() => {
            const btn = document.querySelector('[data-testid="category-selection-button"]') ||
                        document.querySelector('button[class*="category"]');
            if (btn) btn.click();
        });
        await wait(2000);
    }

    // Now on category selection page — select each level
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        console.log(`... selecting: ${part}`);

        // Wait for category links to be present
        await page.waitForSelector('.category-selection-list-item-link', { timeout: 10000 });

        // Get current links before clicking
        const beforeLinks = await page.evaluate(() =>
            [...document.querySelectorAll('.category-selection-list-item-link')].map(a => a.textContent.trim())
        );

        // Click the matching link
        const found = await page.evaluate((name) => {
            for (const a of document.querySelectorAll('.category-selection-list-item-link')) {
                if (a.textContent.trim() === name) { a.click(); return true; }
            }
            return false;
        }, part);

        if (!found) {
            console.log(`... could not find category: ${part}`);
            break;
        }

        // If not last part, wait for subcategory list to update
        if (i < parts.length - 1) {
            await page.waitForFunction((before) => {
                const now = [...document.querySelectorAll('.category-selection-list-item-link')].map(a => a.textContent.trim());
                return JSON.stringify(now) !== JSON.stringify(before);
            }, { timeout: 10000 }, beforeLinks);
            await wait(300);
        }
    }

    // Check for art sub-selection (e.g. cat_{value} radio buttons)
    await wait(500);
    const hasArt = await page.evaluate(() => !!document.querySelector('[id^="cat_"]'));
    if (hasArt) {
        // Art selection is handled by the form after navigation
    }

    // Click "Weiter" to go back to form
    const weiterClicked = await page.evaluate(() => {
        for (const btn of document.querySelectorAll('button, a')) {
            if (btn.textContent.trim() === 'Weiter') { btn.click(); return true; }
        }
        return false;
    });

    if (weiterClicked) {
        // Wait for navigation back to form page
        try {
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
        } catch (e) {}
        await page.waitForSelector(SELECTORS.title, { visible: true, timeout: 15000 });
        await wait(500);
    }

    console.log('... category selection complete.');
}

const resolveAttr = (key) => key.replace(/_s$/, '');

async function fillAttribute(page, attrName, value) {
    const info = await page.evaluate((name) => {
        const h = document.querySelector(`input[name="attributeMap[${name}]"]`);
        if (!h) return null;
        const el = document.getElementById(name);
        if (!el) return { type: 'hidden-only' };
        const tag = el.tagName.toLowerCase(), role = el.getAttribute('role') || '', hp = el.getAttribute('aria-haspopup') || '';
        if (tag === 'button' && hp === 'dialog') return { type: 'dialog', id: name };
        if (tag === 'button' && role === 'combobox') return { type: 'combobox', id: name };
        if (tag === 'input' && role === 'combobox') return { type: 'autocomplete', id: name };
        if (tag === 'input') return { type: 'input', id: name };
        if (tag === 'select') return { type: 'select', id: name };
        return null;
    }, attrName);
    if (!info) return false;
    const eid = (info.id || '').replace(/\./g, '\\.');

    const typeInField = async (sel, text) => {
        await page.waitForSelector(sel, { visible: true, timeout: 5000 });
        await page.click(sel, { clickCount: 3 }); await page.keyboard.press('Backspace');
        await page.type(sel, String(text));
    };

    switch (info.type) {
        case 'combobox': {
            await page.click(`#${eid}`); await wait(300);
            const s = await page.evaluate((v) => {
                for (const o of document.querySelectorAll('[role="option"]')) {
                    if ((o.getAttribute('data-value') || '') === v || o.textContent.trim().toLowerCase() === v.toLowerCase()) { o.click(); return true; }
                }
                return false;
            }, value);
            if (!s) await page.keyboard.press('Escape'); await wait(200); return s;
        }
        case 'dialog': {
            await page.click(`#${eid}`); await wait(500);
            return await page.evaluate((v) => {
                const d = document.querySelector('dialog[aria-modal="true"]');
                if (!d) return false;
                for (const r of d.querySelectorAll('input[type="radio"]')) if (r.value === v) { r.click(); break; }
                for (const b of d.querySelectorAll('button')) if (b.textContent.trim().toLowerCase().includes('bestätigen')) { b.click(); return true; }
                return false;
            }, value);
        }
        case 'autocomplete': {
            await page.click(`#${eid}`);
            await page.evaluate((s) => { document.querySelector(s).value = ''; }, `#${eid}`);
            await page.type(`#${eid}`, value, { delay: 40 }); await wait(600);
            const p = await page.evaluate((v) => {
                for (const o of document.querySelectorAll('[role="option"]'))
                    if (o.textContent.trim().toLowerCase() === v.toLowerCase()) { o.click(); return true; }
                return false;
            }, value);
            if (!p) { await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); }
            await wait(300); return true;
        }
        case 'select': await page.select(`#${eid}`, value); return true;
        case 'input': await typeInField(`#${eid}`, value); return true;
        default: return false;
    }
}

async function handleShipping(page, adData) {
    const shipping = adData.shippingOptions || [];
    if (shipping.length === 0) return;

    // Open shipping dialog
    try {
        await page.waitForSelector('#ad-shipping-options', { visible: true, timeout: 3000 });
        await page.click('#ad-shipping-options'); await wait(500);

        // Click "Andere Versandmethoden"
        const clicked = await page.evaluate(() => {
            for (const btn of document.querySelectorAll('button, a')) {
                if (btn.textContent.includes('Andere Versandmethoden')) { btn.click(); return true; }
            }
            return false;
        });
        if (!clicked) return;
        await wait(500);

        // Determine package size from carrier IDs
        const sizeMap = { '001': 'Klein', '002': 'Mittel', '003': 'Mittel', '004': 'Groß', '005': 'Groß' };
        const firstSuffix = shipping[0]?.split('_')[1];
        const size = sizeMap[firstSuffix] || 'Mittel';

        // Select package size
        await page.evaluate((sz) => {
            for (const btn of document.querySelectorAll('button, [role="radio"], label')) {
                if (btn.textContent.includes(sz)) { btn.click(); return; }
            }
        }, size);
        await wait(500);

        // Select specific carriers
        for (const carrierId of shipping) {
            await page.evaluate((id) => {
                const el = document.querySelector(`[data-carrier-id="${id}"]`) ||
                           document.querySelector(`input[value="${id}"]`);
                if (el) el.click();
            }, carrierId);
            await wait(200);
        }

        // Confirm
        await page.evaluate(() => {
            for (const btn of document.querySelectorAll('button')) {
                if (btn.textContent.trim().toLowerCase().includes('bestätigen') || btn.textContent.trim().toLowerCase().includes('übernehmen')) {
                    btn.click(); return;
                }
            }
        });
        await wait(500);
    } catch (e) { console.log('Shipping setup skipped:', e.message); }
}

async function runAutomation(page, adData, photoFiles) {
    const typeInField = async (sel, text) => {
        if (!text) return;
        await page.waitForSelector(sel, { visible: true, timeout: 5000 });
        await page.click(sel, { clickCount: 3 }); await page.keyboard.press('Backspace');
        await page.type(sel, String(text));
    };

    // Category selection
    if (adData.categoryPath) {
        console.log('Selecting category on form page...');
        console.log(`Category path: ${adData.categoryPath}`);
        await selectCategory(page, adData.categoryPath);
    }

    // Wait for form to be ready
    await page.waitForSelector(SELECTORS.title, { visible: true, timeout: 15000 });

    // Title
    await typeInField(SELECTORS.title, adData.title);

    // Description
    if (adData.description) {
        await page.waitForSelector(SELECTORS.description, { visible: true });
        await page.click(SELECTORS.description);
        await page.evaluate((s) => { document.querySelector(s).value = ''; }, SELECTORS.description);
        await page.type(SELECTORS.description, adData.description);
    }

    // Price
    await typeInField(SELECTORS.price, adData.price);

    // Price type
    if (adData.priceType) {
        const labels = { 'FIXED': 'Festpreis', 'NEGOTIABLE': 'VB', 'GIVE_AWAY': 'Zu verschenken' };
        await selectComboboxOption(page, SELECTORS.priceType, labels[adData.priceType] || adData.priceType);
    }

    // Attributes (dynamic fields, autocomplete, condition)
    const attrs = {};
    if (adData.dynamicFields) for (const [k, v] of Object.entries(adData.dynamicFields)) attrs[resolveAttr(k)] = v;
    if (adData.autocompleteFields) for (const [k, v] of Object.entries(adData.autocompleteFields)) attrs[resolveAttr(k)] = v;
    if (adData.condition) {
        const ca = await page.evaluate(() => {
            const e = document.querySelector('input[name*=".condition"]');
            const m = e && e.name.match(/attributeMap\[(.+)\]/);
            return m ? m[1] : null;
        });
        if (ca) attrs[ca] = adData.condition;
    }
    for (const [k, v] of Object.entries(attrs)) {
        try { await fillAttribute(page, k, v); } catch (e) {}
    }

    // ZIP + City
    if (adData.zipCode) {
        await typeInField(SELECTORS.zipCode, adData.zipCode); await wait(1500);
        const targetCity = adData.city || 'Dortmund - Mitte';
        const current = await page.evaluate(() => {
            const e = document.getElementById('ad-city-selected-option');
            return e ? e.textContent.trim() : '';
        });
        if (current !== targetCity) await selectComboboxOption(page, SELECTORS.city, targetCity);
    }

    // Shipping
    await handleShipping(page, adData);

    // Photos
    if (photoFiles.length > 0) {
        const fi = await page.$(SELECTORS.photoUploadInput);
        if (fi) { await fi.uploadFile(...photoFiles); await wait(5000); }
    }

    console.log('Automation complete.');
}

async function captureFromPage(page) {
    await page.waitForSelector(SELECTORS.title, { visible: true, timeout: 15000 });
    const data = await page.evaluate((SEL) => {
        const v = (s) => { const e = document.querySelector(s); return e ? (e.value || e.textContent || '').trim() : ''; };
        const result = { title: v(SEL.title), description: v(SEL.description), price: v(SEL.price), priceType: '', zipCode: v(SEL.zipCode), city: '', dynamicFields: {}, autocompleteFields: {}, condition: '', shippingOptions: [], photoOrder: [] };
        // Capture price type from button text
        const ptBtn = document.querySelector(SEL.priceType);
        if (ptBtn) result.priceType = ptBtn.textContent.trim();
        // Capture city
        const cityEl = document.getElementById('ad-city-selected-option');
        if (cityEl) result.city = cityEl.textContent.trim();
        // Capture all attribute fields
        for (const inp of document.querySelectorAll('input[name^="attributeMap["]')) {
            const m = inp.name.match(/attributeMap\[(.+)\]/);
            if (m) result.dynamicFields[m[1]] = inp.value;
        }
        return result;
    }, SELECTORS);
    return data;
}

async function main() {
    const folder = getProjectFolder();
    if (!folder) { console.log('No project folder configured. Set it in config.json.'); process.exit(1); }

    while (true) {
        const mode = await ask('\n--> Choose a mode: [1] Run (Post Ad), [2] Capture (New Template), or [3] Exit: ');

        if (mode === '3') { console.log('Bye.'); process.exit(0); }

        if (mode === '1') {
            console.log('--- RUN MODE ---');
            console.log(`Using project folder from config: ${folder}`);
            const templates = listTemplates(folder);
            if (templates.length === 0) { console.log('No templates found.'); continue; }
            console.log('--> Please choose a template to use:');
            templates.forEach((t, i) => console.log(`[${i + 1}] ${t}`));
            const choice = await ask('Enter the number of your choice: ');
            const idx = parseInt(choice, 10) - 1;
            if (idx < 0 || idx >= templates.length) { console.log('Invalid choice.'); continue; }
            const tplName = templates[idx];

            console.log('Connecting to existing Chrome instance...');
            let browser;
            try { browser = await connectToBrowser(); } catch (e) {
                console.log('Could not connect to Chrome. Make sure Chrome is running with --remote-debugging-port=9222.');
                continue;
            }

            try {
                console.log(`Template "${tplName}" selected. Starting automation...`);
                const { data, photos } = loadTemplate(folder, tplName);
                const page = await findAdPage(browser);
                if (!page) throw new Error('Could not find the Kleinanzeigen ad page. Please navigate to the ad posting page before running the script.');
                await page.bringToFront();
                await runAutomation(page, data, photos);
            } catch (e) { console.log('An error occurred during automation:', e); }
            finally { await browser.disconnect(); }
        }

        if (mode === '2') {
            console.log('--- CAPTURE MODE ---');
            const name = await ask('Enter a name for the new template: ');
            if (!name) { console.log('No name given.'); continue; }

            console.log('Connecting to existing Chrome instance...');
            let browser;
            try { browser = await connectToBrowser(); } catch (e) {
                console.log('Could not connect to Chrome. Make sure Chrome is running with --remote-debugging-port=9222.');
                continue;
            }

            try {
                const page = await findAdPage(browser);
                if (!page) throw new Error('Could not find the Kleinanzeigen ad page.');
                await page.bringToFront();
                console.log('Capturing data from page...');
                const data = await captureFromPage(page);
                const dir = path.join(folder, name);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(data, null, 4));
                console.log(`Template saved to ${dir}/data.json`);
                console.log('Note: Copy photos into the folder and set photoOrder in data.json if needed.');
            } catch (e) { console.log('Capture error:', e); }
            finally { await browser.disconnect(); }
        }
    }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
