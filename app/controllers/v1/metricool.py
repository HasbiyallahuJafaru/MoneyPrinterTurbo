"""
Metricool scheduling endpoints.

Flow for a generated video:
    1. (optional) upload the local MP4 to Dropbox to obtain a public URL,
       because Metricool fetches media from a URL and cannot read localhost.
    2. schedule the post via the mcp-metricool server at the chosen date/time
       and timezone ("location").
"""
from typing import Optional

from fastapi import Request
from loguru import logger
from pydantic import BaseModel

from app.controllers import base
from app.controllers.v1.base import new_router
from app.models.exception import HttpException
from app.services.dropbox_upload import dropbox_uploader
from app.services.metricool import metricool_service
from app.utils import file_security, utils

router = new_router()


class MetricoolScheduleRequest(BaseModel):
    # Provide either a task-relative video_path (uploaded to Dropbox for you)
    # and/or already-public media_urls.
    video_path: Optional[str] = None
    media_urls: Optional[list[str]] = None
    text: str = ""
    publish_at: str  # "YYYY-MM-DDTHH:MM:SS", must be in the future
    timezone: Optional[str] = None
    blog_id: Optional[int] = None
    networks: Optional[list[str]] = None
    network_data: Optional[dict] = None
    draft: bool = False


class MetricoolUploadRequest(BaseModel):
    video_path: str  # task-relative path, e.g. "<task_id>/final-1.mp4"


class IntegrationCredentials(BaseModel):
    # Pushed by the desktop app after the user completes OAuth. Applied to the
    # in-memory singletons only (the secrets live in the app's encrypted vault,
    # not in config.toml).
    metricool: Optional[dict] = None
    dropbox: Optional[dict] = None


# Fields the desktop app is allowed to set on each service singleton.
_METRICOOL_FIELDS = (
    "enabled", "mode", "mcp_url", "access_token",
    "user_token", "user_id", "blog_id", "networks", "timezone",
)
_DROPBOX_FIELDS = (
    "enabled", "app_key", "app_secret", "refresh_token",
    "access_token", "dest_folder",
)


@router.post("/integrations/credentials", summary="Apply OAuth credentials in-memory")
def set_credentials(request: Request, body: IntegrationCredentials):
    if body.metricool:
        for key, value in body.metricool.items():
            if key in _METRICOOL_FIELDS:
                if key == "user_id":
                    value = str(value)
                setattr(metricool_service, key, value)
    if body.dropbox:
        for key, value in body.dropbox.items():
            if key in _DROPBOX_FIELDS:
                setattr(dropbox_uploader, key, value)
    return utils.get_response(
        200,
        {
            "metricool_configured": metricool_service.is_configured(),
            "dropbox_configured": dropbox_uploader.is_configured(),
        },
    )


def _resolve_task_video(video_path: str, request_id: str) -> str:
    tasks_dir = utils.task_dir()
    try:
        return file_security.resolve_path_within_directory(tasks_dir, video_path)
    except ValueError as exc:
        raise HttpException(
            task_id=request_id,
            status_code=404 if str(exc) == "file does not exist" else 403,
            message=f"{request_id}: invalid video path",
        )


@router.get("/metricool/status", summary="Metricool / Dropbox integration status")
def metricool_status(request: Request):
    return utils.get_response(
        200,
        {
            "metricool_configured": metricool_service.is_configured(),
            "dropbox_configured": dropbox_uploader.is_configured(),
            "default_blog_id": metricool_service.default_blog_id,
            "default_networks": metricool_service.networks,
            "default_timezone": metricool_service.timezone,
        },
    )


@router.get("/metricool/brands", summary="List Metricool brands (blogId + timezone)")
def metricool_brands(request: Request):
    result = metricool_service.list_brands()
    if not result.get("success"):
        raise HttpException(
            task_id=base.get_task_id(request),
            status_code=502,
            message=result.get("error") or result.get("raw") or "get_brands failed",
        )
    return utils.get_response(200, result.get("data"))


@router.post("/metricool/upload", summary="Upload a generated video to Dropbox")
def metricool_upload(request: Request, body: MetricoolUploadRequest):
    request_id = base.get_task_id(request)
    local_path = _resolve_task_video(body.video_path, request_id)
    result = dropbox_uploader.upload(local_path)
    if not result.get("success"):
        raise HttpException(
            task_id=request_id,
            status_code=502,
            message=result.get("error", "Dropbox upload failed"),
        )
    return utils.get_response(200, {"url": result["url"]})


@router.post("/metricool/schedule", summary="Schedule a video post via Metricool")
def metricool_schedule(request: Request, body: MetricoolScheduleRequest):
    request_id = base.get_task_id(request)

    media_urls = list(body.media_urls or [])
    if body.video_path:
        local_path = _resolve_task_video(body.video_path, request_id)
        upload = dropbox_uploader.upload(local_path)
        if not upload.get("success"):
            raise HttpException(
                task_id=request_id,
                status_code=502,
                message=f"Dropbox upload failed: {upload.get('error')}",
            )
        media_urls.append(upload["url"])

    result = metricool_service.schedule_video(
        text=body.text,
        media_urls=media_urls,
        publish_dt=body.publish_at,
        timezone=body.timezone,
        blog_id=body.blog_id,
        networks=body.networks,
        network_data=body.network_data,
        draft=body.draft,
    )
    if not result.get("success"):
        raise HttpException(
            task_id=request_id,
            status_code=502,
            message=result.get("error") or result.get("raw") or "schedule failed",
        )
    logger.success(f"Metricool post scheduled at {body.publish_at}")
    return utils.get_response(200, {"media_urls": media_urls, "result": result.get("data")})


@router.get("/metricool/scheduled", summary="List scheduled Metricool posts")
def metricool_scheduled(
    request: Request,
    start: str,
    end: str,
    blog_id: Optional[int] = None,
    timezone: Optional[str] = None,
):
    blog_id = int(blog_id or metricool_service.default_blog_id)
    timezone = timezone or metricool_service.timezone
    if not blog_id or not timezone:
        raise HttpException(
            task_id=base.get_task_id(request),
            status_code=400,
            message="blog_id and timezone are required",
        )
    result = metricool_service.get_scheduled_posts(blog_id, start, end, timezone)
    if not result.get("success"):
        raise HttpException(
            task_id=base.get_task_id(request),
            status_code=502,
            message=result.get("error") or result.get("raw") or "query failed",
        )
    return utils.get_response(200, result.get("data"))
