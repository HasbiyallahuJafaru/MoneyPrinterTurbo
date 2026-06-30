"""
Phase 0 live end-to-end test for the Metricool integration, using the REAL app
service code (app/services/metricool.py + dropbox_upload.py).

It proves the full chain on your account WITHOUT publishing anything:
    get_brands -> (optional) Dropbox upload -> post_schedule_post (DRAFT) ->
    get_scheduled_posts.

Set credentials via env (PowerShell example):
    $env:METRICOOL_USER_TOKEN="..."      # required
    $env:METRICOOL_USER_ID="..."         # required
    $env:METRICOOL_BLOG_ID="123"         # optional; else first brand is used
    $env:METRICOOL_TIMEZONE="Asia/Jakarta"   # optional; else brand timezone
    $env:METRICOOL_NETWORKS="tiktok"     # optional; comma-separated
    # Provide ONE media source (a network like tiktok/instagram requires media):
    $env:TEST_VIDEO="C:\\path\\to\\final.mp4"   # uploaded to Dropbox for you
    #   ...needs [dropbox] configured in config.toml, OR instead:
    $env:TEST_MEDIA_URL="https://.../already-public.mp4"

Run:
    python scripts/metricool_e2e_test.py
"""
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.getcwd())

# Feed env credentials into the app config before importing services.
from app.config import config  # noqa: E402

config.metricool["enabled"] = True
config.metricool["user_token"] = os.environ.get("METRICOOL_USER_TOKEN", "")
config.metricool["user_id"] = os.environ.get("METRICOOL_USER_ID", "")

from app.services.dropbox_upload import dropbox_uploader  # noqa: E402
from app.services.metricool import metricool_service  # noqa: E402

# Rebuild the singletons so they pick up the injected config.
metricool_service.__init__()
metricool_service.enabled = True
metricool_service.user_token = os.environ["METRICOOL_USER_TOKEN"]
metricool_service.user_id = os.environ["METRICOOL_USER_ID"]


def _first_brand(brands):
    """Pull (blog_id, timezone) out of the get_brands payload, best-effort."""
    items = brands
    if isinstance(brands, dict):
        items = brands.get("data") or brands.get("brands") or list(brands.values())
    if isinstance(items, list) and items:
        b = items[0]
        if isinstance(b, dict):
            bid = b.get("id") or b.get("blogId") or b.get("blog_id")
            tz = b.get("timezone") or b.get("timeZone") or ""
            return bid, tz
    return None, ""


def main():
    print("== 1. get_brands ==")
    brands = metricool_service.list_brands()
    print(brands)
    if not brands.get("success"):
        sys.exit("get_brands failed — check token / user_id.")

    blog_id = os.environ.get("METRICOOL_BLOG_ID")
    timezone = os.environ.get("METRICOOL_TIMEZONE")
    auto_bid, auto_tz = _first_brand(brands.get("data"))
    blog_id = int(blog_id or auto_bid or 0)
    timezone = timezone or auto_tz
    print(f"\nUsing blog_id={blog_id}, timezone={timezone}")
    if not blog_id or not timezone:
        sys.exit("Could not determine blog_id/timezone; set METRICOOL_BLOG_ID + METRICOOL_TIMEZONE.")

    media_urls = []
    test_url = os.environ.get("TEST_MEDIA_URL")
    test_video = os.environ.get("TEST_VIDEO")
    if test_url:
        media_urls = [test_url]
    elif test_video:
        print("\n== 2. Dropbox upload ==")
        up = dropbox_uploader.upload(test_video)
        print(up)
        if not up.get("success"):
            sys.exit("Dropbox upload failed.")
        media_urls = [up["url"]]
    else:
        print("\n(no TEST_VIDEO/TEST_MEDIA_URL; scheduling text-only draft)")

    networks = [n.strip() for n in os.environ.get("METRICOOL_NETWORKS", "tiktok").split(",")]
    publish_at = (datetime.now() + timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%S")

    print(f"\n== 3. post_schedule_post (DRAFT) at {publish_at} ==")
    res = metricool_service.schedule_video(
        text="MoneyPrinterTurbo e2e test (draft, safe to delete).",
        media_urls=media_urls,
        publish_dt=publish_at,
        timezone=timezone,
        blog_id=blog_id,
        networks=networks,
        network_data={"youtube": {"title": "e2e test", "madeForKids": False}},
        draft=True,
    )
    print(res)

    print("\n== 4. get_scheduled_posts (next 7 days) ==")
    start = datetime.now().strftime("%Y-%m-%d")
    end = (datetime.now() + timedelta(days=7)).strftime("%Y-%m-%d")
    print(metricool_service.get_scheduled_posts(blog_id, start, end, timezone))


if __name__ == "__main__":
    main()
