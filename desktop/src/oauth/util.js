// Shared OAuth helpers: PKCE generation + a one-shot loopback redirect server.
const http = require("http");
const crypto = require("crypto");

function base64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function createPkce() {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(
    crypto.createHash("sha256").update(verifier).digest()
  );
  return { verifier, challenge };
}

function randomState() {
  return base64url(crypto.randomBytes(24));
}

// Starts an HTTP server on 127.0.0.1:<port>, resolves with the query params of
// the first request whose `state` matches. Rejects on error/timeout.
function waitForRedirect(port, expectedState, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const params = Object.fromEntries(url.searchParams.entries());
      // Ignore favicon and any non-callback noise.
      if (!params.code && !params.error) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body style='font-family:sans-serif;padding:40px'>" +
          "<h2>Connected.</h2>You can close this tab and return to MoneyPrinterTurbo." +
          "</body></html>"
      );
      cleanup();
      if (params.error) {
        reject(new Error(params.error_description || params.error));
      } else if (expectedState && params.state !== expectedState) {
        reject(new Error("OAuth state mismatch"));
      } else {
        resolve(params);
      }
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("OAuth timed out waiting for redirect"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      server.close();
    }

    server.on("error", (e) => {
      cleanup();
      reject(e);
    });
    server.listen(port, "127.0.0.1");
  });
}

module.exports = { base64url, createPkce, randomState, waitForRedirect };
