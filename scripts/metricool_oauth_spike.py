"""
Prove that the hosted Metricool MCP (https://ai.metricool.com/mcp) can be
authorized programmatically via OAuth login — no token/user-id pasting.

This is exactly the flow the Electron app will run behind a "Connect Metricool"
button: open the browser, let the user log into Metricool and approve, catch the
redirect on a localhost loopback, exchange for tokens, then call `get_brands`.

Tokens + the dynamically-registered client are cached at
~/.moneyprinterturbo/metricool_oauth.json so re-runs don't prompt again
(refresh tokens are used automatically).

Run:
    python scripts/metricool_oauth_spike.py
A browser window opens; log in to Metricool and approve. The script then prints
your brands. Set OAUTH_PORT to change the loopback port (default 8765).
"""
import asyncio
import json
import os
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

from mcp import ClientSession
from mcp.client.auth import OAuthClientProvider, TokenStorage
from mcp.client.streamable_http import streamablehttp_client
from mcp.shared.auth import OAuthClientInformationFull, OAuthClientMetadata, OAuthToken

SERVER_URL = os.environ.get("METRICOOL_MCP_URL", "https://ai.metricool.com/mcp")
PORT = int(os.environ.get("OAUTH_PORT", "8765"))
REDIRECT_URI = f"http://127.0.0.1:{PORT}/callback"
CACHE_DIR = os.path.join(os.path.expanduser("~"), ".moneyprinterturbo")
CACHE_FILE = os.path.join(CACHE_DIR, "metricool_oauth.json")


class FileTokenStorage(TokenStorage):
    """Persist OAuth tokens + the DCR client info to a JSON file."""

    def __init__(self, path: str):
        self.path = path
        self._data = {}
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    self._data = json.load(f)
            except (ValueError, OSError):
                self._data = {}

    def _flush(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self._data, f, indent=2)

    async def get_tokens(self):
        raw = self._data.get("tokens")
        return OAuthToken.model_validate(raw) if raw else None

    async def set_tokens(self, tokens: OAuthToken):
        self._data["tokens"] = tokens.model_dump(mode="json")
        self._flush()

    async def get_client_info(self):
        raw = self._data.get("client_info")
        return OAuthClientInformationFull.model_validate(raw) if raw else None

    async def set_client_info(self, client_info: OAuthClientInformationFull):
        self._data["client_info"] = client_info.model_dump(mode="json")
        self._flush()


class _CallbackHandler(BaseHTTPRequestHandler):
    result: dict = {}

    def do_GET(self):  # noqa: N802
        qs = parse_qs(urlparse(self.path).query)
        _CallbackHandler.result = {
            "code": qs.get("code", [None])[0],
            "state": qs.get("state", [None])[0],
            "error": qs.get("error", [None])[0],
        }
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(
            b"<html><body><h2>Metricool connected.</h2>"
            b"You can close this tab and return to the app.</body></html>"
        )

    def log_message(self, *args):  # silence noisy default logging
        pass


def _run_loopback_until_hit() -> dict:
    server = HTTPServer(("127.0.0.1", PORT), _CallbackHandler)
    # handle_request blocks until exactly one request is served.
    server.handle_request()
    server.server_close()
    return _CallbackHandler.result


async def main():
    storage = FileTokenStorage(CACHE_FILE)

    async def redirect_handler(auth_url: str) -> None:
        print(f"\n[oauth] opening browser to authorize:\n{auth_url}\n")
        webbrowser.open(auth_url)

    async def callback_handler() -> tuple[str, str | None]:
        print(f"[oauth] waiting for redirect on {REDIRECT_URI} ...")
        result = await asyncio.to_thread(_run_loopback_until_hit)
        if result.get("error"):
            raise RuntimeError(f"OAuth error: {result['error']}")
        if not result.get("code"):
            raise RuntimeError("No authorization code received.")
        print("[oauth] authorization code received.")
        return result["code"], result.get("state")

    client_metadata = OAuthClientMetadata(
        redirect_uris=[REDIRECT_URI],
        client_name="MoneyPrinterTurbo Desktop",
        grant_types=["authorization_code", "refresh_token"],
        response_types=["code"],
        token_endpoint_auth_method="none",  # public client (PKCE)
    )

    auth = OAuthClientProvider(
        server_url=SERVER_URL,
        client_metadata=client_metadata,
        storage=storage,
        redirect_handler=redirect_handler,
        callback_handler=callback_handler,
    )

    print(f"[oauth] connecting to hosted Metricool MCP: {SERVER_URL}")
    async with streamablehttp_client(SERVER_URL, auth=auth) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            print("[oauth] session initialized — authorized!\n")

            tools = (await session.list_tools()).tools
            print(f"[oauth] {len(tools)} tools available (hosted MCP):\n")
            for t in tools:
                desc = (t.description or "").strip().splitlines()
                first = desc[0] if desc else ""
                print(f"  - {t.name}: {first}")
                print(f"      schema: {json.dumps(t.inputSchema)}")

            # Try to find and call a brands-listing tool, whatever it's named.
            brand_tool = next(
                (t.name for t in tools if "brand" in t.name.lower()), None
            )
            if brand_tool:
                print(f"\n== calling {brand_tool} ==")
                res = await session.call_tool(brand_tool, {})
                for c in res.content:
                    print(getattr(c, "text", c))
            else:
                print("\n[oauth] no brand-listing tool found in hosted toolset.")

    print(f"\n[oauth] tokens cached at {CACHE_FILE} — future runs won't prompt.")


if __name__ == "__main__":
    asyncio.run(main())
