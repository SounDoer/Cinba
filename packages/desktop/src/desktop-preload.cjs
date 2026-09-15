const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cinbaDesktop", {
  getState: () => ipcRenderer.invoke("desktop:get-state"),
  selectProfile: (profileId) => ipcRenderer.invoke("desktop:select-profile", profileId),
  retry: () => ipcRenderer.invoke("desktop:retry"),
  openManager: () => ipcRenderer.invoke("desktop:open-manager"),
  addProfile: (input) => ipcRenderer.invoke("desktop:add-profile", input),
  updateProfile: (profileId, input) =>
    ipcRenderer.invoke("desktop:update-profile", profileId, input),
  removeProfile: (profileId) => ipcRenderer.invoke("desktop:remove-profile", profileId),
  recoverProfiles: () => ipcRenderer.invoke("desktop:recover-profiles"),
  testProfile: (input) => ipcRenderer.invoke("desktop:test-profile", input),
  onStateChanged: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("desktop:state-changed", handler);
    return () => ipcRenderer.removeListener("desktop:state-changed", handler);
  },
});
