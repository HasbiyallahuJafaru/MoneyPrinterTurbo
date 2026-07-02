const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getStatus: () => ipcRenderer.invoke("integration:status"),
  connectMetricool: () => ipcRenderer.invoke("integration:connectMetricool"),
  connectDropbox: () => ipcRenderer.invoke("integration:connectDropbox"),
  disconnect: (provider) => ipcRenderer.invoke("integration:disconnect", provider),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),

  metricoolBrands: () => ipcRenderer.invoke("metricool:brands"),
  metricoolScheduled: (query) => ipcRenderer.invoke("metricool:scheduled", query),
  metricoolSchedule: (payload) => ipcRenderer.invoke("metricool:schedule", payload),

  appConfig: () => ipcRenderer.invoke("app:config"),
  configGet: () => ipcRenderer.invoke("config:get"),
  configSave: (keys) => ipcRenderer.invoke("config:save", keys),

  scriptGenerate: (body) => ipcRenderer.invoke("script:generate", body),
  videoGenerate: (params) => ipcRenderer.invoke("video:generate", params),
  videoStatus: (taskId) => ipcRenderer.invoke("video:status", taskId),
  videoExport: (rel, name) => ipcRenderer.invoke("video:export", rel, name),
  backendBase: () => ipcRenderer.invoke("app:config"),

  onBackendState: (cb) =>
    ipcRenderer.on("backend:state", (_e, healthy) => cb(healthy)),
  onBackendLog: (cb) => ipcRenderer.on("backend:log", (_e, line) => cb(line)),
});
