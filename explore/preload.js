const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getItems: () => ipcRenderer.invoke('get-items'),
    getCategories: () => ipcRenderer.invoke('get-categories'),
    saveItem: (itemPath, data) => ipcRenderer.invoke('save-item', { itemPath, data }),
    getThumbnail: (filePath) => ipcRenderer.invoke('get-thumbnail', { filePath }),
    addPhotos: (itemPath) => ipcRenderer.invoke('add-photos', { itemPath }),
    removePhoto: (itemPath, filename) => ipcRenderer.invoke('remove-photo', { itemPath, filename }),
    runAutomation: (itemPaths) => ipcRenderer.invoke('run-automation', { itemPaths }),
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    createItem: (name) => ipcRenderer.invoke('create-item', { name }),
});
