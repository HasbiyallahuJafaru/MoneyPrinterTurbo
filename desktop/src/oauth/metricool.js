// Metricool hosted-MCP OAuth (standard MCP auth): discover -> dynamic client
// registration -> PKCE authorization-code -> token. Proven against the real
// server by scripts/metricool_oauth_spike.py.
const { shell } = require("electron");
const C = require("../config");
const store = require("../store");
const { createPkce, randomState, waitForRedirect } = require("./util");

const REDIRECT_URI = `http://127.0.0.1:${C.METRICOOL_REDIRECT_PORT}/callback`;

async function discover() {
  try {
    const r = await fetch(C.METRICOOL_AS_METADATA);
    if (r.ok) return await r.json();
  } catch {
    /* fall through to known defaults */
  }
  return {
    authorization_endpoint: "https://app.metricool.com/oauth/authorize",
    token_endpoint: "https://app.metricool.com/oauth/token",
    registration_endpoint: "https://app.metricool.com/oauth/register",
  };
}

async function ensureClient(meta) {
  const cached = store.get("metricool") || {};
  if (cached.client_id) return cached.client_id;
  const r = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      client_name: "MoneyPrinterTurbo Desktop",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: C.METRICOOL_SCOPE,
    }),
  });
  if (!r.ok) throw new Error(`Metricool client registration failed: ${r.status}`);
  const data = await r.json();
  store.set("metricool", { ...cached, client_id: data.client_id });
  return data.client_id;
}

function persistTokens(tokens, clientId) {
  const prev = store.get("metricool") || {};
  store.set("metricool", {
    ...prev,
    client_id: clientId || prev.client_id,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || prev.refresh_token,
    expires_at: tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000 - 60000
      : Date.now() + 3600000,
  });
}

// Full interactive login. Opens the browser, catches the loopback redirect.
async function connect() {
  const meta = await discover();
  const clientId = await ensureClient(meta);
  const { verifier, challenge } = createPkce();
  const state = randomState();

  const authUrl =
    `${meta.authorization_endpoint}?` +
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: C.METRICOOL_SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: C.METRICOOL_MCP_URL,
    }).toString();

  const waiter = waitForRedirect(C.METRICOOL_REDIRECT_PORT, state);
  await shell.openExternal(authUrl);
  const params = await waiter;

  const tokenRes = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  });
  if (!tokenRes.ok) {
    throw new Error(`Metricool token exchange failed: ${tokenRes.status}`);
  }
  const tokens = await tokenRes.json();
  persistTokens(tokens, clientId);
  return tokens.access_token;
}

// Returns a valid (refreshed if needed) access token, or null if not connected.
async function getAccessToken() {
  const m = store.get("metricool");
  if (!m || !m.access_token) return null;
  if (Date.now() < (m.expires_at || 0)) return m.access_token;
  if (!m.refresh_token) return m.access_token; // best effort
  const meta = await discover();
  const r = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: m.refresh_token,
      client_id: m.client_id,
    }).toString(),
  });
  if (!r.ok) return m.access_token;
  const tokens = await r.json();
  persistTokens(tokens, m.client_id);
  return tokens.access_token;
}

function isConnected() {
  const m = store.get("metricool");
  return !!(m && m.access_token);
}

function disconnect() {
  store.clear("metricool");
}

module.exports = { connect, getAccessToken, isConnected, disconnect };
