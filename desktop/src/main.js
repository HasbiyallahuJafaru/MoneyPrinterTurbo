const path = require("path");
const { app, BrowserWindow, ipcMain } = require("electron");
const C = require("./config");
const store = require("./store");
const backend = require("./backend");
const metricool = require("./oauth/metricool");
const dropbox = require("./oauth/dropbox");

let win = null;
let backendHealthy = false;

function log(line) {
  if (win && !win.isDestroyed()) win.webContents.send("backend:log", String(line));
}

function setBackendState(healthy) {
  backendHealthy = healthy;
  if (win && !win.isDestroyed()) win.webContents.send("backend:state", healthy);
}

async function backendFetch(method, apiPath, body) {
  try {
    const res = await fetch(`${C.BACKEND_API}${apiPath}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    // Most commonly the backend isn't running yet. Fail gracefully so the UI
    // can show a message instead of an unhandled rejection.
    return {
      ok: false,
      status: 0,
      data: { message: "Backend is not reachable. Start it and try again." },
    };
  }
}

// Push the latest OAuth tokens + defaults into the running backend (in-memory).
async function pushCredentials() {
  if (!backendHealthy) return;
  const settings = store.get("settings") || {};
  const mToken = await metricool.getAccessToken();
  const dToken = await dropbox.getAccessToken();

  const payload = {
    metricool: mToken
      ? {
          enabled: true,
          mode: "oauth",
          mcp_url: C.METRICOOL_MCP_URL,
          access_token: mToken,
          blog_id: settings.blogId || 0,
          networks: settings.networks || ["tiktok", "instagram"],
          timezone: settings.timezone || "",
        }
      : { enabled: false },
    dropbox: dToken
      ? {
          enabled: true,
          access_token: dToken,
          dest_folder: settings.dropboxFolder || "/MoneyPrinterTurbo",
        }
      : { enabled: false },
  };
  try {
    await backendFetch("POST", "/api/v1/integrations/credentials", payload);
  } catch (e) {
    log(`[creds] push failed: ${e.message}`);
  }
}

function statusObject() {
  return {
    metricool: metricool.isConnected(),
    dropbox: dropbox.isConnected(),
    backendHealthy,
    settings: store.get("settings") || {},
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "MoneyPrinterTurbo",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

function registerIpc() {
  ipcMain.handle("integration:status", () => statusObject());

  ipcMain.handle("integration:connectMetricool", async () => {
    await metricool.connect();
    await pushCredentials();
    return statusObject();
  });

  ipcMain.handle("integration:connectDropbox", async () => {
    await dropbox.connect();
    await pushCredentials();
    return statusObject();
  });

  ipcMain.handle("integration:disconnect", async (_e, provider) => {
    if (provider === "metricool") metricool.disconnect();
    if (provider === "dropbox") dropbox.disconnect();
    await pushCredentials();
    return statusObject();
  });

  ipcMain.handle("settings:save", async (_e, settings) => {
    store.set("settings", { ...(store.get("settings") || {}), ...settings });
    await pushCredentials();
    return statusObject();
  });

  ipcMain.handle("metricool:brands", async () => {
    await pushCredentials();
    return backendFetch("GET", "/api/v1/metricool/brands");
  });

  ipcMain.handle("metricool:scheduled", async (_e, q) => {
    await pushCredentials();
    const params = new URLSearchParams(q).toString();
    return backendFetch("GET", `/api/v1/metricool/scheduled?${params}`);
  });

  ipcMain.handle("metricool:schedule", async (_e, payload) => {
    await pushCredentials();
    return backendFetch("POST", "/api/v1/metricool/schedule", payload);
  });

  ipcMain.handle("app:config", () => ({
    streamlitUrl: C.STREAMLIT_URL,
    backendApi: C.BACKEND_API,
  }));

  ipcMain.handle("config:get", () => backendFetch("GET", "/api/v1/config"));
  ipcMain.handle("config:save", (_e, keys) =>
    backendFetch("POST", "/api/v1/config", { keys })
  );

  ipcMain.handle("video:generate", (_e, params) =>
    backendFetch("POST", "/api/v1/videos", params)
  );
  ipcMain.handle("video:status", (_e, taskId) =>
    backendFetch("GET", `/api/v1/tasks/${taskId}`)
  );
}

app.whenReady().then(async () => {
  registerIpc();
  createWindow();

  backend.launch(log);
  const healthy = await backend.waitForHealthy();
  setBackendState(healthy);
  if (healthy) {
    log("[backend] healthy");
    await pushCredentials();
  } else {
    log("[backend] not reachable — generation/scheduling will be unavailable until it starts");
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => backend.stop());
