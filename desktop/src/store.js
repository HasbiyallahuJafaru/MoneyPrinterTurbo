// Encrypted on-disk vault for OAuth tokens + user settings.
// Secrets are encrypted with Electron safeStorage (OS keychain-backed). On
// platforms where encryption is unavailable we fall back to base64 (clearly
// not secure) so the app still runs.
const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");

function vaultFile() {
  return path.join(app.getPath("userData"), "vault.json");
}

function readVault() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(vaultFile(), "utf8"));
  } catch {
    return {};
  }
  try {
    if (raw.enc && safeStorage.isEncryptionAvailable()) {
      return JSON.parse(safeStorage.decryptString(Buffer.from(raw.enc, "base64")));
    }
    if (raw.plain) {
      return JSON.parse(Buffer.from(raw.plain, "base64").toString("utf8"));
    }
  } catch {
    return {};
  }
  return {};
}

function writeVault(obj) {
  const json = JSON.stringify(obj || {});
  let payload;
  if (safeStorage.isEncryptionAvailable()) {
    payload = { enc: safeStorage.encryptString(json).toString("base64") };
  } else {
    payload = { plain: Buffer.from(json, "utf8").toString("base64") };
  }
  fs.writeFileSync(vaultFile(), JSON.stringify(payload));
}

function get(key) {
  return readVault()[key];
}

function set(key, value) {
  const v = readVault();
  v[key] = value;
  writeVault(v);
}

function clear(key) {
  const v = readVault();
  delete v[key];
  writeVault(v);
}

module.exports = { readVault, writeVault, get, set, clear };
