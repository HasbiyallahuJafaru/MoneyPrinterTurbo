"""
Metricool scheduling via the official `mcp-metricool` MCP server.

We talk to the MCP server programmatically over stdio (no LLM) using the `mcp`
Python client SDK. This path works on any Metricool plan, including the free
tier (free caps: 20 scheduled posts, 30-day analytics). The direct REST API,
by contrast, requires a paid Advanced/Custom plan.

Key constraint: the MCP exposes no media-upload tool. `post_schedule_post`'s
`info.media` is a list of public URLs that Metricool fetches itself, so the
caller must pass already-hosted URLs (see app/services/dropbox_upload.py).
"""
import asyncio
import json
import shutil
import sys
from typing import Optional

from loguru import logger

from app.config import config

# Networks that require a video/image to be present. Used only for a friendly
# pre-flight warning; Metricool enforces the real rules server-side.
_MEDIA_REQUIRED = {"instagram", "tiktok", "youtube", "pinterest"}


def _parse_tool_result(result) -> dict:
    """Flatten an MCP CallToolResult into a plain dict we can return as JSON."""
    texts = []
    for c in getattr(result, "content", []) or []:
        text = getattr(c, "text", None)
        if text is not None:
            texts.append(text)
    raw = "\n".join(texts).strip()
    is_error = bool(getattr(result, "isError", False))
    parsed = None
    if raw:
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            parsed = raw
    return {"success": not is_error, "data": parsed, "raw": raw}


class MetricoolService:
    def __init__(self):
        cfg = getattr(config, "metricool", {}) or {}
        self.enabled = cfg.get("enabled", False)
        # "oauth"  -> hosted MCP at mcp_url, authorized via OAuth login (friendly,
        #             access_token supplied by the desktop app's OAuth flow).
        # "token"  -> local stdio mcp-metricool server using user_token + user_id.
        self.mode = cfg.get("mode", "token")
        self.mcp_url = cfg.get("mcp_url", "https://ai.metricool.com/mcp")
        self.access_token = cfg.get("access_token", "")  # OAuth bearer
        self.user_token = cfg.get("user_token", "")
        self.user_id = str(cfg.get("user_id", ""))
        self.default_blog_id = cfg.get("blog_id", 0)
        self.networks = cfg.get("networks", ["tiktok", "instagram"])
        self.timezone = cfg.get("timezone", "")  # falls back to brand timezone
        self.auto_schedule = cfg.get("auto_schedule", False)
        # Optional explicit command override; otherwise auto-detect.
        self._server_command = cfg.get("server_command", "")

    def is_configured(self) -> bool:
        if not self.enabled:
            return False
        if self.mode == "oauth":
            return bool(self.access_token and self.mcp_url)
        return bool(self.user_token and self.user_id)

    # --- MCP plumbing -----------------------------------------------------

    def _resolve_command(self) -> list[str]:
        if self._server_command:
            import shlex

            return shlex.split(self._server_command)
        exe = shutil.which("mcp-metricool")
        if exe:
            return [exe]
        if shutil.which("uvx"):
            return ["uvx", "mcp-metricool"]
        return [sys.executable, "-m", "mcp_metricool"]

    async def _call(self, tool: str, args: dict) -> dict:
        if self.mode == "oauth":
            return await self._call_remote(tool, args)
        return await self._call_stdio(tool, args)

    async def _call_remote(self, tool: str, args: dict) -> dict:
        """Hosted Metricool MCP over streamable HTTP, authorized by OAuth bearer.

        The desktop app performs the interactive OAuth login and supplies the
        resulting access token via config (`metricool.access_token`).
        """
        from mcp import ClientSession
        from mcp.client.streamable_http import streamablehttp_client

        headers = (
            {"Authorization": f"Bearer {self.access_token}"}
            if self.access_token
            else {}
        )
        async with streamablehttp_client(self.mcp_url, headers=headers) as (
            read,
            write,
            _get_session_id,
        ):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(tool, args)
                return _parse_tool_result(result)

    async def _call_stdio(self, tool: str, args: dict) -> dict:
        import os

        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        cmd = self._resolve_command()
        params = StdioServerParameters(
            command=cmd[0],
            args=cmd[1:],
            env={
                **os.environ,
                "METRICOOL_USER_TOKEN": self.user_token,
                "METRICOOL_USER_ID": self.user_id,
            },
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(tool, args)
                return _parse_tool_result(result)

    def _run(self, tool: str, args: dict) -> dict:
        if not self.is_configured():
            return {"success": False, "error": "Metricool is not configured"}
        try:
            return asyncio.run(self._call(tool, args))
        except Exception as e:  # noqa: BLE001
            logger.error(f"Metricool MCP call '{tool}' failed: {e}")
            return {"success": False, "error": str(e)}

    # --- Public API -------------------------------------------------------

    def list_brands(self) -> dict:
        # The hosted (OAuth) MCP and the local (token) MCP expose different tool
        # names for the same operation.
        tool = "getBrandSettings" if self.mode == "oauth" else "get_brands"
        return self._run(tool, {})

    def get_scheduled_posts(
        self, blog_id: int, start: str, end: str, timezone: str
    ) -> dict:
        if self.mode == "oauth":
            return self._run(
                "getScheduledPosts",
                {
                    "brandId": str(blog_id),
                    "fromDate": start,
                    "toDate": end,
                    "timezone": timezone,
                    "extendedRange": False,
                },
            )
        return self._run(
            "get_scheduled_posts",
            {
                "blog_id": int(blog_id),
                "start": start,
                "end": end,
                "timezone": timezone,
                "extendedRange": False,
            },
        )

    def build_info(
        self,
        text: str,
        media_urls: list[str],
        networks: list[str],
        publish_dt: str,
        timezone: str,
        network_data: Optional[dict] = None,
        draft: bool = False,
        auto_publish: bool = True,
    ) -> dict:
        """Assemble the `info` payload for post_schedule_post.

        `network_data` may carry per-network overrides keyed by network name,
        e.g. {"youtube": {"title": "...", "madeForKids": False}}.
        """
        network_data = network_data or {}
        info = {
            "autoPublish": auto_publish,
            "draft": draft,
            "shortener": False,
            "firstCommentText": "",
            "descendants": [],
            "hasNotReadNotes": False,
            "media": media_urls,
            "mediaAltText": [],
            "smartLinkData": {"ids": []},
            "providers": [{"network": n} for n in networks],
            "publicationDate": {"dateTime": publish_dt, "timezone": timezone},
            "text": text,
        }
        for net in networks:
            key = f"{net}Data"
            info[key] = network_data.get(net, {})
        return info

    def schedule_video(
        self,
        text: str,
        media_urls: list[str],
        publish_dt: str,
        timezone: str,
        blog_id: Optional[int] = None,
        networks: Optional[list[str]] = None,
        network_data: Optional[dict] = None,
        draft: bool = False,
    ) -> dict:
        """Schedule one post (optionally multi-network) for a hosted video.

        publish_dt: "YYYY-MM-DDTHH:MM:SS" (must be in the future).
        timezone:   IANA tz, e.g. "Asia/Jakarta". Falls back to configured tz.
        """
        blog_id = int(blog_id or self.default_blog_id)
        networks = networks or self.networks
        timezone = timezone or self.timezone
        if not blog_id:
            return {"success": False, "error": "blog_id is required"}
        if not timezone:
            return {"success": False, "error": "timezone is required"}
        if any(n in _MEDIA_REQUIRED for n in networks) and not media_urls:
            logger.warning(
                f"networks {networks} require media but none provided; "
                "Metricool will likely reject this."
            )

        info = self.build_info(
            text=text,
            media_urls=media_urls,
            networks=networks,
            publish_dt=publish_dt,
            timezone=timezone,
            network_data=network_data,
            draft=draft,
        )
        logger.info(
            f"Scheduling Metricool post -> blog {blog_id}, networks "
            f"{networks}, at {publish_dt} {timezone}"
        )
        if self.mode == "oauth":
            # Hosted MCP: blogId is a string and info is a JSON-encoded string.
            return self._run(
                "createScheduledPost",
                {
                    "date": publish_dt,
                    "blogId": str(blog_id),
                    "info": json.dumps(info),
                },
            )
        return self._run(
            "post_schedule_post",
            {"date": publish_dt, "blog_id": blog_id, "info": info},
        )


metricool_service = MetricoolService()
