// Central constants for the desktop shell.
const path = require("path");
const fs = require("fs");

// Repo root = two levels up from desktop/src.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Prefer the project's .venv interpreter, then MPT_PYTHON, then PATH python.
function detectPython() {
  if (process.env.MPT_PYTHON) return process.env.MPT_PYTHON;
  const candidates = [
    path.join(REPO_ROOT, ".venv", "Scripts", "python.exe"), // Windows
    path.join(REPO_ROOT, ".venv", "bin", "python"), // POSIX
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "python";
}

module.exports = {
  REPO_ROOT,
  BACKEND_API: "http://127.0.0.1:8080",
  // /ping isn't wired into the app; /openapi.json is always 200 when FastAPI is up.
  BACKEND_PING: "http://127.0.0.1:8080/openapi.json",
  STREAMLIT_URL: "http://localhost:8501",
  STREAMLIT_PORT: 8501,

  // Metricool hosted MCP (OAuth).
  METRICOOL_MCP_URL: "https://ai.metricool.com/mcp",
  METRICOOL_AS_METADATA:
    "https://ai.metricool.com/.well-known/oauth-authorization-server",
  METRICOOL_SCOPE: "mcp:read mcp:write",
  METRICOOL_REDIRECT_PORT: 8765,

  // Dropbox OAuth (PKCE). App key is public (safe to ship); no secret needed.
  // Until we register a first-party app, allow override via env.
  DROPBOX_APP_KEY: process.env.DROPBOX_APP_KEY || "",
  DROPBOX_AUTH_URL: "https://www.dropbox.com/oauth2/authorize",
  DROPBOX_TOKEN_URL: "https://api.dropboxapi.com/oauth2/token",
  DROPBOX_REDIRECT_PORT: 8766,

  // Spawn the Python backend ourselves unless told not to (useful while
  // iterating on the shell without a full Python env).
  AUTO_START_BACKEND: process.env.MPT_NO_BACKEND !== "1",
  PYTHON: detectPython(),
};
