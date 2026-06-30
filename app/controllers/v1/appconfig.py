"""
App configuration endpoints for the desktop "API Keys" screen.

Exposes a curated allow-list of `[app]` settings (provider API keys, model
names, video-source keys) so the native UI can read and save them. Saving
updates the in-memory config and persists to config.toml via save_config().
"""
from typing import Optional

from fastapi import Request
from pydantic import BaseModel

from app.config import config
from app.controllers.v1.base import new_router
from app.utils import utils

router = new_router()

# Keys whose value is a list of strings (comma-separated in the UI).
LIST_KEYS = {
    "pexels_api_keys",
    "pixabay_api_keys",
    "coverr_api_keys",
    "twelvelabs_api_keys",
}

# Curated, editable subset of [app] settings surfaced in the desktop UI.
ALLOWED_KEYS = (
    # video sources
    "pexels_api_keys",
    "pixabay_api_keys",
    "coverr_api_keys",
    # llm
    "llm_provider",
    "openai_api_key", "openai_base_url", "openai_model_name",
    "gemini_api_key", "gemini_model_name",
    "deepseek_api_key", "deepseek_base_url", "deepseek_model_name",
    "moonshot_api_key", "moonshot_base_url", "moonshot_model_name",
    "qwen_api_key", "qwen_model_name",
    "aihubmix_api_key", "aihubmix_base_url", "aihubmix_model_name",
    "volcengine_api_key", "volcengine_base_url", "volcengine_model_name",
    "ollama_base_url", "ollama_model_name",
    # subtitles
    "subtitle_provider",
)


class AppConfigUpdate(BaseModel):
    keys: dict


def _normalize(key: str, value):
    if key in LIST_KEYS:
        if isinstance(value, str):
            return [v.strip() for v in value.split(",") if v.strip()]
        if isinstance(value, list):
            return [str(v).strip() for v in value if str(v).strip()]
        return []
    return value


@router.get("/config", summary="Read editable app settings")
def get_config(request: Request):
    # Local single-user desktop app over loopback: returning actual values is
    # acceptable and lets the user edit them in place.
    data = {key: config.app.get(key, [] if key in LIST_KEYS else "") for key in ALLOWED_KEYS}
    return utils.get_response(200, data)


@router.post("/config", summary="Save editable app settings")
def update_config(request: Request, body: AppConfigUpdate):
    changed = []
    for key, value in body.keys.items():
        if key in ALLOWED_KEYS:
            config.app[key] = _normalize(key, value)
            changed.append(key)
    config.save_config()
    return utils.get_response(200, {"saved": changed})
