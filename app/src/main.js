const { app, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const APP_ROOT = path.join(__dirname, '..');
const PROJECT_ROOT = path.join(APP_ROOT, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');
const CATEGORIES_PATH = path.join(APP_ROOT, 'categories.json');
const SHIPPING_PATH = path.join(APP_ROOT, 'shipping-options.json');
const ICON_PATH = path.join(APP_ROOT, 'assets', 'icon.png');
const THUMB_DIR = path.join(PROJECT_ROOT, '.thumbs');
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];

function thumbPath(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.heic') return filePath;
    if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });
    const hash = crypto.createHash('md5').update(filePath).digest('hex');
    const out = path.join(THUMB_DIR, hash + '.jpg');
    if (!fs.existsSync(out)) {
        try {
            // execFileSync (no shell) — paths with quotes/spaces/backticks are safe.
            execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', '400', filePath, '--out', out], { stdio: 'ignore' });
        } catch (e) { return filePath; }
    }
    return out;
}

function getProjectFolder() {
    try {
        const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        if (c.projectFolder && fs.existsSync(c.projectFolder)) return c.projectFolder;
    } catch (e) {}
    return null;
}

function loadCategories() {
    try { return JSON.parse(fs.readFileSync(CATEGORIES_PATH, 'utf-8')); } catch (e) { return null; }
}

// A `posted` timestamp counts as "recent" for 24h. After that we fall back
// to treating the item as unposted (sort, gray-out, tag) so it can be re-listed.
const POSTED_RECENT_MS = 24 * 60 * 60 * 1000;
function isPostedRecently(data) {
    if (!data || !data.posted) return false;
    const t = Date.parse(data.posted);
    if (isNaN(t)) return false;
    return (Date.now() - t) < POSTED_RECENT_MS;
}

function loadItems(folder) {
    if (!folder || !fs.existsSync(folder)) return [];
    return fs.readdirSync(folder, { withFileTypes: true })
        .filter(d => d.isDirectory() && !['node_modules', '.git', 'VERKAUFT', 'Other', '.thumbs'].includes(d.name))
        .map(d => {
            const p = path.join(folder, d.name);
            const dp = path.join(p, 'data.json');
            let data = {};
            try { data = JSON.parse(fs.readFileSync(dp, 'utf-8')); } catch (e) {}
            const imgs = fs.readdirSync(p).filter(f => IMAGE_EXTS.includes(path.extname(f).toLowerCase()));
            let ordered;
            if (data.photoOrder && Array.isArray(data.photoOrder)) {
                const o = data.photoOrder.filter(f => imgs.includes(f));
                ordered = [...o, ...imgs.filter(f => !o.includes(f)).sort()];
            } else { ordered = imgs.sort(); }
            return { name: d.name, path: p, data, images: ordered };
        })
        .sort((a, b) => {
            // Recently-posted items (within 24h) go to the bottom; most-recent first.
            const ap = isPostedRecently(a.data) ? a.data.posted : null;
            const bp = isPostedRecently(b.data) ? b.data.posted : null;
            if (ap && !bp) return 1;
            if (!ap && bp) return -1;
            if (ap && bp) return bp.localeCompare(ap);
            return a.name.localeCompare(b.name);
        });
}

function saveItem(itemPath, data) {
    fs.writeFileSync(path.join(itemPath, 'data.json'), JSON.stringify(data, null, 4));
}

let win;
function createWindow() {
    const icon = nativeImage.createFromPath(ICON_PATH);
    if (process.platform === 'darwin' && app.dock) app.dock.setIcon(icon);
    win = new BrowserWindow({
        width: 1200, height: 800, minWidth: 900, minHeight: 600,
        titleBarStyle: 'hiddenInset', icon: ICON_PATH, title: 'Kleinanzeigen Upload',
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
    });
    win.loadFile(path.join(__dirname, 'index.html'));
    const sendFs = () => { try { win.webContents.send('fullscreen-changed', win.isFullScreen()); } catch (e) {} };
    win.on('enter-full-screen', sendFs);
    win.on('leave-full-screen', sendFs);
    win.webContents.on('did-finish-load', sendFs);
}

app.setName('Kleinanzeigen Upload');
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

ipcMain.handle('get-items', () => ({ folder: getProjectFolder(), items: loadItems(getProjectFolder()) }));
ipcMain.handle('get-categories', () => loadCategories());
ipcMain.handle('save-item', (_, { itemPath, data }) => { saveItem(itemPath, data); return true; });
ipcMain.handle('get-thumbnail', (_, { filePath }) => thumbPath(filePath));

ipcMain.handle('add-photos', async (_, { itemPath }) => {
    const r = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'heic'] }]
    });
    if (r.canceled) return [];
    const added = [];
    for (const src of r.filePaths) {
        const fn = path.basename(src);
        const dest = path.join(itemPath, fn);
        if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
        added.push(fn);
    }
    return added;
});

ipcMain.handle('remove-photo', (_, { itemPath, filename }) => {
    const fp = path.join(itemPath, filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    return true;
});

let automationRunning = false;
ipcMain.handle('run-automation', async (event, { itemPaths, submit }) => {
    if (automationRunning) return [{ success: false, error: 'Bereits ein Automation-Lauf aktiv' }];
    if (!(await isDebugChromeRunning())) return (itemPaths || []).map(p => ({ itemPath: p, success: false, error: 'Chrome nicht verbunden. Erst 🌐 klicken.' }));
    automationRunning = true;
    try {
        const { runSingleItem } = require(path.join(__dirname, 'automation.js'));
        const results = [];
        const total = itemPaths.length;
        for (let i = 0; i < total; i++) {
            const p = itemPaths[i];
            try { event.sender.send('automation-progress', { index: i, total, itemPath: p, phase: 'start' }); } catch (e) {}
            try {
                await runSingleItem(p, { submit: !!submit });
                results.push({ itemPath: p, success: true });
                if (submit) {
                    // Mark item as posted so it doesn't show up in the editor next time.
                    try {
                        const dp = path.join(p, 'data.json');
                        const data = JSON.parse(fs.readFileSync(dp, 'utf-8'));
                        data.posted = new Date().toISOString();
                        saveItem(p, data);
                    } catch (e) { /* ignore */ }
                }
                try { event.sender.send('automation-progress', { index: i, total, itemPath: p, phase: 'done', success: true }); } catch (e) {}
            } catch (e) {
                results.push({ itemPath: p, success: false, error: e.message });
                try { event.sender.send('automation-progress', { index: i, total, itemPath: p, phase: 'done', success: false, error: e.message }); } catch (e2) {}
                // If we were actually submitting and one fails, stop the batch
                // rather than charging ahead — likely the page is in a broken
                // state and subsequent items would fail too.
                if (submit) break;
            }
        }
        return results;
    } finally { automationRunning = false; }
});

ipcMain.handle('select-folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (r.canceled) return null;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ projectFolder: r.filePaths[0] }, null, 4));
    return r.filePaths[0];
});

ipcMain.handle('create-item', async (_, { name }) => {
    const folder = getProjectFolder();
    if (!folder) return null;
    const p = path.join(folder, name);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    saveItem(p, { title: name, description: '', price: '', priceType: 'FIXED', zipCode: '44141', city: 'Dortmund - Mitte', categoryPath: '', condition: '', dynamicFields: {}, autocompleteFields: {}, shippingOptions: [], photoOrder: [] });
    return p;
});

ipcMain.handle('bulk-update', (_, { itemPaths, patch }) => {
    const updated = [];
    for (const p of itemPaths || []) {
        const dp = path.join(p, 'data.json');
        if (!fs.existsSync(dp)) continue;
        let data = {};
        try { data = JSON.parse(fs.readFileSync(dp, 'utf-8')); } catch (e) { continue; }
        // Apply known patch fields. Anything outside this allowlist is ignored
        // to avoid foot-guns in bulk operations.
        if (patch.shippingOptions !== undefined) data.shippingOptions = patch.shippingOptions;
        if (patch.priceType !== undefined) data.priceType = patch.priceType;
        if (patch.condition !== undefined) data.condition = patch.condition;
        if (patch.buyNow !== undefined) data.buyNow = !!patch.buyNow;
        if (patch.versandMode !== undefined) {
            data.versandMode = patch.versandMode;
            if (!data.dynamicFields) data.dynamicFields = {};
            const vk = Object.keys(data.dynamicFields).find(k => k.includes('versand'));
            if (vk) data.dynamicFields[vk] = patch.versandMode === 'nein' ? 'nein' : 'ja';
            if (patch.versandMode === 'nein') data.shippingOptions = [];
        }
        try { saveItem(p, data); updated.push(p); } catch (e) {}
    }
    return updated;
});

ipcMain.handle('get-shipping-options', () => {
    try { return JSON.parse(fs.readFileSync(SHIPPING_PATH, 'utf-8')); }
    catch (e) { return null; }
});

ipcMain.handle('refresh-shipping', async () => {
    if (!(await isDebugChromeRunning())) return { ok: false, error: 'Chrome nicht verbunden. Erst 🌐 klicken.' };
    try {
        const puppeteer = require(path.join(APP_ROOT, '..', 'node_modules', 'puppeteer'));
        const r = await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/version`);
        const d = await r.json();
        const browser = await puppeteer.connect({ browserWSEndpoint: d.webSocketDebuggerUrl, defaultViewport: null });
        try {
            const pages = await browser.pages();
            let page = pages.find(p => p.url().includes('p-anzeige-aufgeben'));
            if (!page) return { ok: false, error: 'Post-Ad Seite nicht gefunden. Öffne Kleinanzeigen → Anzeige aufgeben.' };
            const data = await page.evaluate(() => {
                const node = document.querySelector('astro-island[component-url*="PostListingForm"]');
                if (!node) return null;
                const props = JSON.parse(node.getAttribute('props') || 'null');
                if (!props || !props.postListingPage) return null;
                // Astro encodes values as [type, value] tuples — unwrap recursively.
                const unwrap = (v) => {
                    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number') {
                        const t = v[0], val = v[1];
                        if (t === 0) return val && typeof val === 'object' ? Object.fromEntries(Object.entries(val).map(([k, x]) => [k, unwrap(x)])) : val;
                        if (t === 1) return Array.isArray(val) ? val.map(unwrap) : val;
                        return val;
                    }
                    if (Array.isArray(v)) return v.map(unwrap);
                    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unwrap(x)]));
                    return v;
                };
                const plp = unwrap(props.postListingPage);
                return plp && plp.availableShippingOptions ? plp.availableShippingOptions : null;
            });
            if (!data) return { ok: false, error: 'Konnte Versand-Daten nicht lesen.' };
            fs.writeFileSync(SHIPPING_PATH, JSON.stringify(data, null, 2));
            return { ok: true, count: (data.options || []).length };
        } finally { await browser.disconnect(); }
    } catch (e) { return { ok: false, error: e.message }; }
});

const CHROME_DEBUG_PORT = 9222;
const CHROME_USER_DIR = '/Users/Max/chrome-dev-session';
const CHROME_APP_PATHS = {
    darwin: '/Applications/Google Chrome.app',
    win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    linux: '/usr/bin/google-chrome',
};

async function isDebugChromeRunning() {
    try {
        const r = await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(800) });
        return r.ok;
    } catch (e) { return false; }
}

ipcMain.handle('chrome-status', async () => ({ running: await isDebugChromeRunning(), port: CHROME_DEBUG_PORT }));

ipcMain.handle('launch-chrome', async () => {
    if (await isDebugChromeRunning()) return { ok: true, alreadyRunning: true };
    const appPath = CHROME_APP_PATHS[process.platform];
    if (!appPath || !fs.existsSync(appPath)) return { ok: false, error: 'Chrome nicht gefunden: ' + (appPath || process.platform) };
    if (!fs.existsSync(CHROME_USER_DIR)) fs.mkdirSync(CHROME_USER_DIR, { recursive: true });
    try {
        if (process.platform === 'darwin') {
            // Use `open -na` so Chrome is launched by launchd with a clean
            // environment and its own session. Spawning the binary directly
            // from Electron causes the child to inherit parent QoS, env, and
            // process-group state, which in practice throttles large uploads.
            const child = spawn('/usr/bin/open', [
                '-na', appPath,
                '--args',
                `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
                `--user-data-dir=${CHROME_USER_DIR}`,
            ], { detached: true, stdio: 'ignore' });
            child.unref();
        } else {
            const exe = appPath;
            const child = spawn(exe, [
                `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
                `--user-data-dir=${CHROME_USER_DIR}`,
            ], { detached: true, stdio: 'ignore' });
            child.unref();
        }
        // Give Chrome a moment to bind the debug port
        for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 250));
            if (await isDebugChromeRunning()) return { ok: true, alreadyRunning: false };
        }
        return { ok: true, alreadyRunning: false, slow: true };
    } catch (e) { return { ok: false, error: e.message }; }
});
