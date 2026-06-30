// Spawns and supervises the Python backend (FastAPI :8080 + Streamlit :8501).
// In a packaged build these become bundled executables (Phase 3); for now we
// launch them with a configurable Python interpreter from the repo root.
const { spawn } = require("child_process");
const C = require("./config");

let procs = [];

function launch(onLog) {
  if (!C.AUTO_START_BACKEND) {
    onLog("[backend] auto-start disabled (MPT_NO_BACKEND=1)");
    return;
  }

  // PYTHONUTF8 forces UTF-8 stdio so loguru can print the app's Unicode log
  // lines (③, font paths) on Windows. Without it cp1252 raises UnicodeEncodeError
  // per line, flooding stderr; a full stderr pipe then blocks the task thread.
  const opts = {
    cwd: C.REPO_ROOT,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
  };

  // Only the FastAPI backend is needed — the native UI drives generation and
  // scheduling directly via its REST API (no Streamlit).
  const api = spawn(C.PYTHON, ["main.py"], opts);
  api.stdout.on("data", (d) => onLog(`[api] ${d}`.trimEnd()));
  api.stderr.on("data", (d) => onLog(`[api] ${d}`.trimEnd()));
  api.on("error", (e) => onLog(`[api] spawn error: ${e.message}`));
  api.on("exit", (code) => onLog(`[api] exited with code ${code}`));
  procs.push(api);
}

async function waitForHealthy({ tries = 60, intervalMs = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(C.BACKEND_PING);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return false;
}

function stop() {
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* ignore */
    }
  }
  procs = [];
}

module.exports = { launch, waitForHealthy, stop };
