const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getItems: () => ipcRenderer.invoke('get-items'),
    getCategories: () => ipcRenderer.invoke('get-categories'),
    saveItem: (itemPath, data) => ipcRenderer.invoke('save-item', { itemPath, data }),
    getThumbnail: (filePath) => ipcRenderer.invoke('get-thumbnail', { filePath }),
    addPhotos: (itemPath) => ipcRenderer.invoke('add-photos', { itemPath }),
    removePhoto: (itemPath, filename) => ipcRenderer.invoke('remove-photo', { itemPath, filename }),
    runAutomation: (itemPaths, opts) => ipcRenderer.invoke('run-automation', { itemPaths, ...(opts || {}) }),
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    createItem: (name) => ipcRenderer.invoke('create-item', { name }),
    bulkUpdate: (itemPaths, patch) => ipcRenderer.invoke('bulk-update', { itemPaths, patch }),
    getShippingOptions: () => ipcRenderer.invoke('get-shipping-options'),
    refreshShipping: () => ipcRenderer.invoke('refresh-shipping'),
    chromeStatus: () => ipcRenderer.invoke('chrome-status'),
    launchChrome: () => ipcRenderer.invoke('launch-chrome'),
    onAutomationProgress: (cb) => {
        const handler = (_, data) => cb(data);
        ipcRenderer.on('automation-progress', handler);
        return () => ipcRenderer.removeListener('automation-progress', handler);
    },
    onFullscreenChanged: (cb) => {
        const handler = (_, isFs) => cb(isFs);
        ipcRenderer.on('fullscreen-changed', handler);
        return () => ipcRenderer.removeListener('fullscreen-changed', handler);
    },
});
