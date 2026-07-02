const path = require("path");
const fs = require("fs");
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

  ipcMain.handle("script:generate", (_e, body) =>
    backendFetch("POST", "/api/v1/scripts", body)
  );
  ipcMain.handle("video:generate", (_e, params) =>
    backendFetch("POST", "/api/v1/videos", params)
  );
  ipcMain.handle("video:status", (_e, taskId) =>
    backendFetch("GET", `/api/v1/tasks/${taskId}`)
  );

  // Copy a finished video into the user's Videos folder.
  ipcMain.handle("video:export", (_e, rel, name) => {
    try {
      const tasksDir = path.join(C.REPO_ROOT, "storage", "tasks");
      const src = path.resolve(tasksDir, rel);
      if (!src.startsWith(tasksDir) || !fs.existsSync(src)) {
        return { ok: false, error: "video not found" };
      }
      const dir = path.join(app.getPath("videos"), "MoneyPrinterTurbo");
      fs.mkdirSync(dir, { recursive: true });
      const slug = (name || "video")
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "video";
      const dest = path.join(dir, `${slug}-${path.basename(src)}`);
      fs.copyFileSync(src, dest);
      return { ok: true, dest };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

// Continuously reflect backend health in the UI. A one-shot check races with a
// slow first import (moviepy/whisper) and can miss the window; polling recovers
// and also re-pushes credentials the moment the backend becomes reachable.
function startHealthMonitor() {
  let last = null;
  const check = async () => {
    let ok = false;
    try {
      const r = await fetch(C.BACKEND_PING);
      ok = r.ok;
    } catch {
      ok = false;
    }
    // Emit every tick so the renderer syncs even if it wasn't listening yet.
    setBackendState(ok);
    if (ok !== last) {
      last = ok;
      if (ok) {
        log("[backend] healthy");
        await pushCredentials();
      } else {
        log("[backend] not reachable — starting up…");
      }
    }
  };
  check();
  setInterval(check, 3000);
}

app.whenReady().then(async () => {
  registerIpc();
  createWindow();
  backend.launch(log);
  startHealthMonitor();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => backend.stop());
