"""
Dropbox uploader used to give Metricool a publicly fetchable URL for a video.

Why this exists:
    The Metricool MCP server has no media-upload tool. `post_schedule_post`
    expects `info.media` to be a list of public URLs that Metricool downloads
    itself, so a locally generated MP4 must first be hosted somewhere reachable
    (localhost will not work). We upload the final video to Dropbox and hand
    Metricool a direct-download URL.

Auth:
    Prefer a long-lived refresh token (app_key + app_secret + refresh_token) so
    the integration keeps working unattended. A short-lived access_token is also
    accepted for quick testing.
"""
import os
from typing import Optional

from loguru import logger

from app.config import config

# Dropbox caps a single files_upload call at 150 MB; above this we must use an
# upload session. Keep a margin below the hard limit.
_CHUNK_THRESHOLD = 140 * 1024 * 1024
_CHUNK_SIZE = 8 * 1024 * 1024


def _to_direct_url(shared_url: str) -> str:
    """Turn a Dropbox share link (HTML preview) into a direct-download URL.

    `https://www.dropbox.com/scl/fi/abc/v.mp4?rlkey=...&dl=0`
        -> `https://dl.dropboxusercontent.com/scl/fi/abc/v.mp4?rlkey=...&dl=1`

    Metricool needs the raw file bytes, not the preview page.
    """
    url = shared_url.replace("www.dropbox.com", "dl.dropboxusercontent.com")
    if "dl=0" in url:
        url = url.replace("dl=0", "dl=1")
    elif "dl=1" not in url:
        url = url + ("&" if "?" in url else "?") + "dl=1"
    return url


class DropboxUploader:
    def __init__(self):
        cfg = getattr(config, "dropbox", {}) or {}
        self.enabled = cfg.get("enabled", False)
        self.app_key = cfg.get("app_key", "")
        self.app_secret = cfg.get("app_secret", "")
        self.refresh_token = cfg.get("refresh_token", "")
        self.access_token = cfg.get("access_token", "")
        self.dest_folder = cfg.get("dest_folder", "/MoneyPrinterTurbo")

    def is_configured(self) -> bool:
        has_refresh = bool(self.app_key and self.app_secret and self.refresh_token)
        return bool(self.enabled and (has_refresh or self.access_token))

    def _client(self):
        # Imported lazily so the base app does not hard-depend on the optional
        # `dropbox` package unless the user actually enables this feature.
        import dropbox

        if self.app_key and self.app_secret and self.refresh_token:
            return dropbox.Dropbox(
                oauth2_refresh_token=self.refresh_token,
                app_key=self.app_key,
                app_secret=self.app_secret,
            )
        return dropbox.Dropbox(self.access_token)

    def upload(self, local_path: str, dest_name: Optional[str] = None) -> dict:
        """Upload a local file and return a direct-download URL.

        Returns {"success": bool, "url": str, "error": str}.
        """
        if not self.is_configured():
            return {"success": False, "error": "Dropbox is not configured"}
        if not os.path.exists(local_path):
            return {"success": False, "error": f"File not found: {local_path}"}

        from dropbox.exceptions import ApiError
        from dropbox.files import WriteMode

        dest_name = dest_name or os.path.basename(local_path)
        dropbox_path = f"{self.dest_folder.rstrip('/')}/{dest_name}"
        size = os.path.getsize(local_path)

        try:
            dbx = self._client()
            with open(local_path, "rb") as f:
                if size <= _CHUNK_THRESHOLD:
                    dbx.files_upload(
                        f.read(), dropbox_path, mode=WriteMode.overwrite
                    )
                else:
                    self._upload_session(dbx, f, dropbox_path, size)

            url = self._get_shared_url(dbx, dropbox_path)
            direct = _to_direct_url(url)
            logger.info(f"✅ Uploaded to Dropbox: {dropbox_path} -> {direct}")
            return {"success": True, "url": direct}
        except ApiError as e:
            logger.error(f"Dropbox API error uploading {local_path}: {e}")
            return {"success": False, "error": str(e)}
        except Exception as e:  # noqa: BLE001
            logger.error(f"Failed to upload to Dropbox: {e}")
            return {"success": False, "error": str(e)}

    def _upload_session(self, dbx, f, dropbox_path: str, size: int) -> None:
        from dropbox.files import CommitInfo, UploadSessionCursor, WriteMode

        start = dbx.files_upload_session_start(f.read(_CHUNK_SIZE))
        cursor = UploadSessionCursor(session_id=start.session_id, offset=f.tell())
        commit = CommitInfo(path=dropbox_path, mode=WriteMode.overwrite)
        while f.tell() < size:
            remaining = size - f.tell()
            if remaining <= _CHUNK_SIZE:
                dbx.files_upload_session_finish(f.read(_CHUNK_SIZE), cursor, commit)
            else:
                dbx.files_upload_session_append_v2(f.read(_CHUNK_SIZE), cursor)
                cursor.offset = f.tell()

    def _get_shared_url(self, dbx, dropbox_path: str) -> str:
        from dropbox.exceptions import ApiError

        try:
            link = dbx.sharing_create_shared_link_with_settings(dropbox_path)
            return link.url
        except ApiError as e:
            # A shared link may already exist; reuse it instead of failing.
            if "shared_link_already_exists" in str(e):
                links = dbx.sharing_list_shared_links(dropbox_path, direct_only=True).links
                if links:
                    return links[0].url
            raise


dropbox_uploader = DropboxUploader()
