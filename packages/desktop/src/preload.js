// 安全桥。渲染层拿不到 Node，只能通过这里暴露的这几个口子跟主进程说话。
// 每多一个口子就是多一份攻击面，所以只开必需的。
//
// 必须是 .js：preload 跑在沙箱化的渲染侧，不经过 Node 的类型剥离。

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cinba", {
  prompt: (text) => ipcRenderer.invoke("cinba:prompt", text),
  abort: () => ipcRenderer.invoke("cinba:abort"),
  respondConfirm: (requestId, confirmed) =>
    ipcRenderer.invoke("cinba:respondConfirm", requestId, confirmed),
  chooseProject: () => ipcRenderer.invoke("cinba:chooseProject"),
  getProject: () => ipcRenderer.invoke("cinba:getProject"),
  getSnapshot: () => ipcRenderer.invoke("cinba:getSnapshot"),
  onActions: (handler) =>
    ipcRenderer.on("cinba:actions", (_event, actions) => handler(actions)),
  onReset: (handler) => ipcRenderer.on("cinba:reset", (_event, cwd) => handler(cwd)),
});
