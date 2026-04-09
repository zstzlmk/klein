const { app, BrowserWindow, ipcMain, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

const APP_ROOT = path.join(__dirname, '..');
const PROJECT_ROOT = path.join(APP_ROOT, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');
const CATEGORIES_PATH = path.join(APP_ROOT, 'categories.json');
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
        try { execSync(`sips -s format jpeg -Z 400 "${filePath}" --out "${out}"`, { stdio: 'ignore' }); }
        catch (e) { return filePath; }
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
        .sort((a, b) => a.name.localeCompare(b.name));
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

ipcMain.handle('run-automation', async (_, { itemPaths }) => {
    const { runSingleItem } = require(path.join(__dirname, 'automation.js'));
    const results = [];
    for (const p of itemPaths) {
        try { await runSingleItem(p); results.push({ itemPath: p, success: true }); }
        catch (e) { results.push({ itemPath: p, success: false, error: e.message }); }
    }
    return results;
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
