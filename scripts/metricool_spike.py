"""
Phase 0 spike: probe the official Metricool MCP server (mcp-metricool) so we can
design the MoneyPrinterTurbo -> Metricool scheduling integration with real,
ground-truth tool schemas instead of guesses.

What it does:
  1. Spawns the `mcp-metricool` server over stdio (no LLM involved).
  2. Lists every tool and prints its JSON input schema. We especially care about
     `post_schedule_post` (how is media/video attached?) and `get_brands`.
  3. If METRICOOL_USER_TOKEN + METRICOOL_USER_ID are set, it also calls
     `get_brands` live to confirm auth works and to read back real blogId values.

Run (from repo root, inside the spike venv created in scratchpad):
    METRICOOL_USER_TOKEN=xxx METRICOOL_USER_ID=yyy python scripts/metricool_spike.py

Listing tool schemas works WITHOUT credentials; only the live get_brands call
needs them.
"""
import asyncio
import json
import os
import shutil
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


def _resolve_server_command() -> list[str]:
    """Prefer the installed console script, fall back to module / uvx."""
    exe = shutil.which("mcp-metricool")
    if exe:
        return [exe]
    if shutil.which("uvx"):
        return ["uvx", "mcp-metricool"]
    # Last resort: run as a module with the current interpreter.
    return [sys.executable, "-m", "mcp_metricool"]


async def main() -> None:
    token = os.environ.get("METRICOOL_USER_TOKEN", "")
    user_id = os.environ.get("METRICOOL_USER_ID", "")

    server = StdioServerParameters(
        command=_resolve_server_command()[0],
        args=_resolve_server_command()[1:],
        env={
            **os.environ,
            "METRICOOL_USER_TOKEN": token,
            "METRICOOL_USER_ID": user_id,
        },
    )

    print(f"[spike] launching: {_resolve_server_command()}")
    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = (await session.list_tools()).tools
            print(f"\n[spike] {len(tools)} tools exposed:\n")
            for t in tools:
                print(f"  - {t.name}: {t.description or ''}")

            interesting = {
                "post_schedule_post",
                "update_schedule_post",
                "get_scheduled_posts",
                "get_brands",
                "get_brands_complete",
            }
            for t in tools:
                if t.name in interesting:
                    print(f"\n===== {t.name} input schema =====")
                    print(json.dumps(t.inputSchema, indent=2, ensure_ascii=False))

            if token and user_id:
                print("\n[spike] credentials present -> calling get_brands live...")
                try:
                    res = await session.call_tool("get_brands", {})
                    for c in res.content:
                        print(getattr(c, "text", c))
                except Exception as e:  # noqa: BLE001
                    print(f"[spike] get_brands failed: {e!r}")
            else:
                print(
                    "\n[spike] no METRICOOL_USER_TOKEN/METRICOOL_USER_ID set; "
                    "skipped live get_brands call."
                )


if __name__ == "__main__":
    asyncio.run(main())
