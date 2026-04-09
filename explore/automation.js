const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const SELECTORS = {
    title: '#ad-title', description: '#ad-description', price: '#ad-price-amount',
    priceType: '#ad-price-type', zipCode: '#ad-zip-code', street: '#ad-street',
    addressVisibility: '#ad-address-visibility', photoUploadInput: 'input[type="file"][accept*="image"]',
};

async function connectToBrowser() {
    const r = await fetch('http://127.0.0.1:9222/json/version');
    const d = await r.json();
    return puppeteer.connect({ browserWSEndpoint: d.webSocketDebuggerUrl, defaultViewport: null });
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

async function runSingleItem(itemPath) {
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
        const pages = await browser.pages();
        let page = null;
        for (const p of pages) {
            if (!p.url().includes('kleinanzeigen.de')) continue;
            try { await p.waitForSelector(SELECTORS.title, { visible: true, timeout: 1500 }); page = p; break; } catch (e) {}
        }
        if (!page) throw new Error('Could not find Kleinanzeigen form page');
        await page.bringToFront();
        await page.waitForSelector(SELECTORS.title, { visible: true, timeout: 15000 });

        const typeInField = async (sel, text) => {
            if (!text) return;
            await page.waitForSelector(sel, { visible: true, timeout: 5000 });
            await page.click(sel, { clickCount: 3 }); await page.keyboard.press('Backspace');
            await page.type(sel, String(text));
        };
        const resolveAttr = (key) => key.replace(/_s$/, '');
        const fillAttribute = async (attrName, value) => {
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
            switch (info.type) {
                case 'combobox': {
                    await page.click(`#${eid}`); await wait(300);
                    const s = await page.evaluate((v) => { for (const o of document.querySelectorAll('[role="option"]')) { if ((o.getAttribute('data-value') || '') === v || o.textContent.trim().toLowerCase() === v.toLowerCase()) { o.click(); return true; } } return false; }, value);
                    if (!s) await page.keyboard.press('Escape'); await wait(200); return s;
                }
                case 'dialog': {
                    await page.click(`#${eid}`); await wait(500);
                    return await page.evaluate((v) => { const d = document.querySelector('dialog[aria-modal="true"]'); if (!d) return false; for (const r of d.querySelectorAll('input[type="radio"]')) if (r.value === v) { r.click(); break; } for (const b of d.querySelectorAll('button')) if (b.textContent.trim().toLowerCase().includes('bestätigen')) { b.click(); return true; } return false; }, value);
                }
                case 'autocomplete': {
                    await page.click(`#${eid}`); await page.evaluate((s) => { document.querySelector(s).value = ''; }, `#${eid}`);
                    await page.type(`#${eid}`, value, { delay: 40 }); await wait(600);
                    const p = await page.evaluate((v) => { for (const o of document.querySelectorAll('[role="option"]')) if (o.textContent.trim().toLowerCase() === v.toLowerCase()) { o.click(); return true; } return false; }, value);
                    if (!p) { await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); } await wait(300); return true;
                }
                case 'select': await page.select(`#${eid}`, value); return true;
                case 'input': await typeInField(`#${eid}`, value); return true;
                default: return false;
            }
        };

        await typeInField(SELECTORS.title, adData.title);
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

        const attrs = {};
        if (adData.dynamicFields) for (const [k, v] of Object.entries(adData.dynamicFields)) attrs[resolveAttr(k)] = v;
        if (adData.autocompleteFields) for (const [k, v] of Object.entries(adData.autocompleteFields)) attrs[resolveAttr(k)] = v;
        if (adData.condition) {
            const ca = await page.evaluate(() => { const e = document.querySelector('input[name*=".condition"]'); const m = e && e.name.match(/attributeMap\[(.+)\]/); return m ? m[1] : null; });
            if (ca) attrs[ca] = adData.condition;
        }
        for (const [k, v] of Object.entries(attrs)) { try { await fillAttribute(k, v); } catch (e) {} }

        if (adData.zipCode) {
            await typeInField(SELECTORS.zipCode, adData.zipCode); await wait(1500);
            const targetCity = adData.city || 'Dortmund - Mitte';
            const current = await page.evaluate(() => { const e = document.getElementById('ad-city-selected-option'); return e ? e.textContent.trim() : ''; });
            if (current !== targetCity) await selectComboboxOption(page, '#ad-city', targetCity);
        }

        if (photoFiles.length > 0) {
            const fi = await page.$(SELECTORS.photoUploadInput);
            if (fi) { await fi.uploadFile(...photoFiles); await wait(5000); }
        }
    } finally { await browser.disconnect(); }
}

module.exports = { runSingleItem };
