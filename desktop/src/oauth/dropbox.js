// Dropbox OAuth via PKCE (public client, no secret). token_access_type=offline
// yields a long-lived refresh token; we refresh the short-lived access token in
// the main process and push it to the Python backend, which does the uploads.
const { shell } = require("electron");
const C = require("../config");
const store = require("../store");
const { createPkce, randomState, waitForRedirect } = require("./util");

const REDIRECT_URI = `http://127.0.0.1:${C.DROPBOX_REDIRECT_PORT}`;

function appKey() {
  // App key is public; prefer the vault (set in Settings) then env/default.
  const s = store.get("settings") || {};
  return s.dropboxAppKey || C.DROPBOX_APP_KEY;
}

function persistTokens(tokens) {
  const prev = store.get("dropbox") || {};
  store.set("dropbox", {
    ...prev,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || prev.refresh_token,
    expires_at: tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000 - 60000
      : Date.now() + 14400000,
  });
}

async function connect() {
  const clientId = appKey();
  if (!clientId) {
    throw new Error(
      "Dropbox app key not set. Add it in Settings (it is public, not a secret)."
    );
  }
  const { verifier, challenge } = createPkce();
  const state = randomState();

  const authUrl =
    `${C.DROPBOX_AUTH_URL}?` +
    new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      token_access_type: "offline",
      state,
    }).toString();

  const waiter = waitForRedirect(C.DROPBOX_REDIRECT_PORT, state);
  await shell.openExternal(authUrl);
  const params = await waiter;

  const r = await fetch(C.DROPBOX_TOKEN_URL, {
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
  if (!r.ok) throw new Error(`Dropbox token exchange failed: ${r.status}`);
  persistTokens(await r.json());
  return true;
}

async function getAccessToken() {
  const d = store.get("dropbox");
  if (!d || !d.access_token) return null;
  if (Date.now() < (d.expires_at || 0)) return d.access_token;
  if (!d.refresh_token) return d.access_token;
  const r = await fetch(C.DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: d.refresh_token,
      client_id: appKey(),
    }).toString(),
  });
  if (!r.ok) return d.access_token;
  persistTokens(await r.json());
  return (store.get("dropbox") || {}).access_token;
}

function isConnected() {
  const d = store.get("dropbox");
  return !!(d && d.access_token);
}

function disconnect() {
  store.clear("dropbox");
}

module.exports = { connect, getAccessToken, isConnected, disconnect };
