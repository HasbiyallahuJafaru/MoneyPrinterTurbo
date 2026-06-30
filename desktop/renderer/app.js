// ---- provider field definitions ------------------------------------------
const PROVIDERS = {
  openai: [["openai_api_key", "API key"], ["openai_base_url", "Base URL (optional)"], ["openai_model_name", "Model"]],
  gemini: [["gemini_api_key", "API key"], ["gemini_model_name", "Model"]],
  deepseek: [["deepseek_api_key", "API key"], ["deepseek_base_url", "Base URL"], ["deepseek_model_name", "Model"]],
  moonshot: [["moonshot_api_key", "API key"], ["moonshot_base_url", "Base URL"], ["moonshot_model_name", "Model"]],
  qwen: [["qwen_api_key", "API key"], ["qwen_model_name", "Model"]],
  aihubmix: [["aihubmix_api_key", "API key"], ["aihubmix_base_url", "Base URL"], ["aihubmix_model_name", "Model"]],
  volcengine: [["volcengine_api_key", "API key"], ["volcengine_base_url", "Base URL"], ["volcengine_model_name", "Model"]],
  ollama: [["ollama_base_url", "Base URL"], ["ollama_model_name", "Model"]],
};

let backendHealthy = false;
let configCache = {};
let cfg = { streamlitUrl: "http://localhost:8501" };

// ---- navigation -----------------------------------------------------------
const views = document.querySelectorAll(".view");
const navItems = document.querySelectorAll(".nav-item");
navItems.forEach((btn) => {
  btn.addEventListener("click", () => {
    navItems.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const name = btn.dataset.view;
    views.forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
    if (name === "schedule") loadBrands();
    if (name === "keys") loadKeys();
  });
});

// ---- backend state --------------------------------------------------------
const backendText = document.getElementById("backend-text");
const backendDot = document.querySelector("#backend-pill .dot");

window.api.appConfig().then((c) => (cfg = c));

window.api.onBackendState((healthy) => {
  backendHealthy = healthy;
  backendText.textContent = healthy ? "Backend ready" : "Backend offline";
  backendDot.className = "dot " + (healthy ? "dot-on" : "dot-off");
  document.getElementById("gen-offline").classList.toggle("hidden", healthy);
});

// ---- logs -----------------------------------------------------------------
const logs = document.getElementById("logs");
document.getElementById("log-toggle").addEventListener("click", () => logs.classList.toggle("hidden"));
window.api.onBackendLog((line) => {
  logs.textContent += line + "\n";
  logs.scrollTop = logs.scrollHeight;
});

// ---- settings / connections ----------------------------------------------
function renderStatus(s) {
  setBadge("m-status", s.metricool);
  setBadge("d-status", s.dropbox);
  toggle("m-disconnect", s.metricool);
  toggle("m-connect", !s.metricool);
  toggle("d-disconnect", s.dropbox);
  toggle("d-connect", !s.dropbox);

  const set = s.settings || {};
  setVal("d-appkey", set.dropboxAppKey);
  setVal("set-blog", set.blogId);
  setVal("set-tz", set.timezone);
  setVal("set-folder", set.dropboxFolder || "/MoneyPrinterTurbo");
}

function setBadge(id, on) {
  const el = document.getElementById(id);
  el.textContent = on ? "Connected" : "Not connected";
  el.className = "badge " + (on ? "badge-on" : "badge-off");
}
function toggle(id, show) { document.getElementById(id).classList.toggle("hidden", !show); }
function setVal(id, v) {
  const el = document.getElementById(id);
  if (el && v !== undefined && v !== null) el.value = v;
}

async function refreshStatus() { renderStatus(await window.api.getStatus()); }

on("m-connect", "click", busy("m-connect", async () => renderStatus(await window.api.connectMetricool())));
on("m-disconnect", "click", async () => renderStatus(await window.api.disconnect("metricool")));
on("d-connect", "click", busy("d-connect", async () => {
  await window.api.saveSettings({ dropboxAppKey: val("d-appkey") });
  renderStatus(await window.api.connectDropbox());
}));
on("d-disconnect", "click", async () => renderStatus(await window.api.disconnect("dropbox")));

on("set-save", "click", async () => {
  await window.api.saveSettings({
    dropboxAppKey: val("d-appkey"),
    blogId: numOrStr(val("set-blog")),
    timezone: val("set-tz"),
    dropboxFolder: val("set-folder") || "/MoneyPrinterTurbo",
  });
  flash("set-saved");
  await refreshStatus();
});

// ---- API keys -------------------------------------------------------------
const providerSel = document.getElementById("k-provider");
providerSel.addEventListener("change", () => renderProviderFields(providerSel.value, configCache));

async function loadKeys() {
  const offline = document.getElementById("keys-offline");
  if (!backendHealthy) { offline.classList.remove("hidden"); return; }
  offline.classList.add("hidden");
  const resp = await window.api.configGet();
  const c = (resp.ok && resp.data && resp.data.data) || {};
  configCache = c;
  setVal("k-pexels", (c.pexels_api_keys || []).join(", "));
  setVal("k-pixabay", (c.pixabay_api_keys || []).join(", "));
  setVal("k-coverr", (c.coverr_api_keys || []).join(", "));
  if (c.llm_provider && PROVIDERS[c.llm_provider]) providerSel.value = c.llm_provider;
  document.getElementById("k-subtitle").value = c.subtitle_provider ?? "edge";
  renderProviderFields(providerSel.value, c);
}

function renderProviderFields(provider, c) {
  const wrap = document.getElementById("provider-fields");
  wrap.innerHTML = PROVIDERS[provider]
    .map(([key, label]) => {
      const isSecret = key.endsWith("_api_key");
      return `<div class="field">
        <label for="cfg_${key}">${label}</label>
        <input id="cfg_${key}" type="${isSecret ? "password" : "text"}" value="${escapeAttr(c[key] || "")}" />
      </div>`;
    })
    .join("");
}

on("k-save", "click", busy("k-save", async () => {
  if (!backendHealthy) return;
  const keys = {
    pexels_api_keys: val("k-pexels"),
    pixabay_api_keys: val("k-pixabay"),
    coverr_api_keys: val("k-coverr"),
    llm_provider: providerSel.value,
    subtitle_provider: document.getElementById("k-subtitle").value,
  };
  for (const [key] of PROVIDERS[providerSel.value]) {
    keys[key] = val(`cfg_${key}`);
  }
  const resp = await window.api.configSave(keys);
  if (resp.ok) flash("k-saved");
}));

// ---- generate -------------------------------------------------------------
on("g-generate", "click", () => generate());

async function generate() {
  const err = document.getElementById("g-error");
  setResult(err, true, "");
  err.className = "result";
  if (!backendHealthy) return setResult(err, false, "Backend is offline.");
  const subject = val("g-subject");
  if (!subject) return setResult(err, false, "Enter a subject.");

  const params = {
    video_subject: subject,
    video_script: val("g-script"),
    video_language: byId("g-language").value,
    video_aspect: byId("g-aspect").value,
    video_source: byId("g-source").value,
    voice_name: byId("g-voice").value,
    voice_rate: Number(val("g-rate") || 1),
    video_clip_duration: Number(val("g-clip") || 5),
    video_count: Number(val("g-count") || 1),
    paragraph_number: Number(val("g-paragraphs") || 1),
    bgm_type: byId("g-bgm").value,
    subtitle_enabled: byId("g-subs").checked,
    font_size: Number(val("g-fontsize") || 60),
    subtitle_position: byId("g-position").value,
  };

  byId("g-results").innerHTML = "";
  setGenBusy(true);
  setStatus("Submitting…");
  const resp = await window.api.videoGenerate(params);
  if (!resp.ok) {
    setGenBusy(false);
    return setResult(err, false, resp.data?.message || "Failed to start generation.");
  }
  const taskId = resp.data?.data?.task_id;
  if (!taskId) {
    setGenBusy(false);
    return setResult(err, false, "No task id returned.");
  }
  pollTask(taskId);
}

function pollTask(taskId) {
  setProgress(0);
  const tick = async () => {
    const r = await window.api.videoStatus(taskId);
    if (!r.ok) {
      setStatus("Waiting for backend…");
      return setTimeout(tick, 3000);
    }
    const t = (r.data && r.data.data) || {};
    const prog = t.progress || 0;
    setProgress(prog);
    if (t.state === 1) {
      setStatus("Done");
      setGenBusy(false);
      return renderResults(t);
    }
    if (t.state === -1) {
      setStatus("");
      setGenBusy(false);
      return setResult(byId("g-error"), false, "Generation failed — check the logs.");
    }
    setStatus(`Working… ${prog}%`);
    setTimeout(tick, 2500);
  };
  tick();
}

function renderResults(task) {
  const wrap = byId("g-results");
  const base = cfg.backendApi || "http://127.0.0.1:8080";
  const vids = task.videos || [];
  let html = "";
  if (task.script) {
    html += `<div class="card"><h3>Script</h3><div class="script-block">${escapeHtml(task.script)}</div></div>`;
  }
  vids.forEach((u) => {
    const rel = toTaskRel(u);
    html += `<div class="video-card">
        <video src="${toAbs(u, base)}" controls preload="metadata"></video>
        <div class="vc-body">
          <span class="vc-name">${escapeHtml(rel)}</span>
          <div class="vc-actions">
            <button class="btn btn-ghost btn-sm" data-path="${escapeAttr(rel)}" data-now="0">Schedule</button>
            <button class="btn btn-primary btn-sm" data-path="${escapeAttr(rel)}" data-now="1">Post now</button>
          </div>
        </div>
      </div>`;
  });
  if (!vids.length) html += `<div class="notice">No videos were returned.</div>`;
  wrap.innerHTML = html;
  wrap.querySelectorAll("[data-path]").forEach((b) =>
    b.addEventListener("click", () => prefillSchedule(b.dataset.path, b.dataset.now === "1"))
  );
}

function prefillSchedule(path, postNow) {
  navigateTo("schedule");
  setVal("s-video", path);
  if (postNow) {
    byId("s-when").value = localDt(10);
    byId("s-draft").checked = false;
  }
  loadBrands();
}

function setGenBusy(b) {
  byId("g-generate").disabled = b;
  byId("g-progress").classList.toggle("hidden", !b);
}
function setProgress(p) { byId("g-progress-bar").style.width = Math.max(0, Math.min(100, p)) + "%"; }
function setStatus(s) { byId("g-status").textContent = s; }

// ---- schedule -------------------------------------------------------------
let brandsCache = [];

async function loadBrands() {
  const sel = document.getElementById("s-brand");
  const resp = await window.api.metricoolBrands();
  const arr = extractBrands(resp);
  brandsCache = arr;
  if (!arr.length) {
    sel.innerHTML = `<option value="">Connect Metricool first</option>`;
    return;
  }
  sel.innerHTML = arr
    .map((b) => `<option value="${b.id}" data-tz="${b.timezone || ""}">${b.label || b.id}</option>`)
    .join("");
  const tz = arr[0].timezone || "";
  if (tz && !val("s-tz")) document.getElementById("s-tz").value = tz;
  sel.onchange = () => {
    const opt = sel.options[sel.selectedIndex];
    if (opt && opt.dataset.tz) document.getElementById("s-tz").value = opt.dataset.tz;
  };
}

function extractBrands(resp) {
  const payload = resp && resp.data && resp.data.data;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return [];
}

on("s-submit", "click", busy("s-submit", async () => {
  const result = document.getElementById("s-result");
  const networks = [...document.querySelectorAll("#s-networks input:checked")].map((c) => c.value);
  const when = val("s-when");
  if (!val("s-video")) return setResult(result, false, "Video path is required.");
  if (!when) return setResult(result, false, "Pick a publish date and time.");
  if (!networks.length) return setResult(result, false, "Select at least one network.");

  const resp = await window.api.metricoolSchedule({
    video_path: val("s-video"),
    text: val("s-text"),
    networks,
    publish_at: when.length === 16 ? when + ":00" : when,
    timezone: val("s-tz"),
    blog_id: numOrStr(val("s-brand")),
    draft: document.getElementById("s-draft").checked,
  });
  if (resp.ok) setResult(result, true, "Scheduled\n" + JSON.stringify(resp.data.data, null, 2));
  else setResult(result, false, resp.data?.message || JSON.stringify(resp.data));
}));

on("s-refresh", "click", async () => {
  const blog = numOrStr(val("s-brand")) || numOrStr(val("set-blog"));
  const tz = val("s-tz") || val("set-tz");
  const today = new Date();
  const resp = await window.api.metricoolScheduled({
    start: iso(today),
    end: iso(new Date(today.getTime() + 30 * 864e5)),
    blog_id: blog,
    timezone: tz,
  });
  document.getElementById("s-list").textContent = resp.ok
    ? JSON.stringify(resp.data.data, null, 2)
    : "Error: " + (resp.data?.message || JSON.stringify(resp.data));
});

// ---- helpers --------------------------------------------------------------
function on(id, ev, fn) { document.getElementById(id).addEventListener(ev, fn); }
function byId(id) { return document.getElementById(id); }
function val(id) { return document.getElementById(id).value.trim(); }
function navigateTo(name) { document.querySelector(`.nav-item[data-view="${name}"]`).click(); }
function localDt(offsetMin) {
  const d = new Date(Date.now() + offsetMin * 60000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function toAbs(u, base) {
  if (/^https?:/.test(u)) return u;
  return u.startsWith("/") ? base + u : base + "/" + u;
}
function toTaskRel(u) {
  const i = u.indexOf("tasks/");
  return i >= 0 ? u.slice(i + 6) : u.replace(/^https?:\/\/[^/]+\//, "");
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function numOrStr(v) { return v && /^\d+$/.test(v) ? Number(v) : v; }
function iso(d) { return d.toISOString().slice(0, 10) + "T00:00:00"; }
function escapeAttr(s) { return String(s).replace(/"/g, "&quot;"); }
function flash(id) {
  const el = document.getElementById(id);
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 1600);
}
function setResult(el, ok, msg) {
  el.className = "result " + (ok ? "ok" : "err");
  el.textContent = msg;
}
function busy(id, fn) {
  return async () => {
    const el = document.getElementById(id);
    el.disabled = true;
    try {
      await fn();
    } catch (e) {
      const r = document.getElementById("s-result");
      if (r && document.getElementById("view-schedule").classList.contains("active")) {
        setResult(r, false, e.message);
      }
      console.error(e);
    } finally {
      el.disabled = false;
    }
  };
}

refreshStatus();
