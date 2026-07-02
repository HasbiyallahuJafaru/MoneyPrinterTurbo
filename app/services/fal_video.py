"""
fal.ai Kling text-to-video source.

Stock footage (Pexels/Pixabay) often doesn't match niche topics. This source
generates topic-relevant clips from the script's search terms with fal.ai's
Kling model instead. It returns local mp4 paths, so the rest of the pipeline
(combine/subtitle/render) is unchanged.

fal queue flow: submit -> poll status -> fetch result -> download. Clips run in
parallel. Note: this costs money per second of video and is slow (~1-4 min per
clip); it is opt-in via video_source = "klingai".
"""
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from loguru import logger

from app.config import config
from app.models import const
from app.services import state as sm
from app.utils import utils

FAL_QUEUE = "https://queue.fal.run"
_DEFAULT_MODEL = "fal-ai/kling-video/v1.6/standard/text-to-video"
# Source step maps onto the 40-50 band of overall task progress.
_DL_START, _DL_END = 40, 50
_MAX_CLIPS = 12  # cost guard


def is_configured() -> bool:
    return bool(config.app.get("fal_api_key", ""))


def _headers() -> dict:
    key = config.app.get("fal_api_key", "")
    return {"Authorization": f"Key {key}", "Content-Type": "application/json"}


def _kling_duration(max_clip_duration: int) -> str:
    # Kling standard text-to-video only accepts 5 or 10 seconds.
    return "10" if max_clip_duration and max_clip_duration > 7 else "5"


def _publish(task_id: str, materials: list):
    if not task_id:
        return
    done = sum(1 for m in materials if m["status"] in ("done", "failed"))
    frac = done / len(materials) if materials else 0.0
    progress = _DL_START + int((_DL_END - _DL_START) * frac)
    sm.state.update_task(
        task_id,
        state=const.TASK_STATE_PROCESSING,
        progress=progress,
        materials=materials,
    )


def generate_videos(
    task_id: str,
    prompts,
    video_aspect,
    audio_duration: float,
    max_clip_duration: int = 5,
) -> list:
    if not is_configured():
        logger.error("fal.ai API key is not set (fal_api_key)")
        return []
    prompts = [p for p in (prompts or []) if str(p).strip()]
    if not prompts:
        logger.error("no prompts to generate KlingAI videos")
        return []

    model = (config.app.get("fal_kling_model", "") or _DEFAULT_MODEL).strip()
    duration = _kling_duration(max_clip_duration)
    dur_s = int(duration)
    aspect = getattr(video_aspect, "value", video_aspect) or "9:16"

    n = max(1, math.ceil(audio_duration / dur_s))
    n = min(n, _MAX_CLIPS)
    clip_prompts = [prompts[i % len(prompts)] for i in range(n)]
    logger.info(f"generating {n} KlingAI clips ({dur_s}s, {aspect}) via {model}")

    materials = [
        {
            "name": f"AI clip {i + 1}",
            "source": "klingai",
            "clip_seconds": dur_s,
            "percent": 0,
            "status": "generating",
        }
        for i in range(n)
    ]
    _publish(task_id, materials)

    results = [None] * n

    def _one(i: int, prompt: str):
        try:
            path = _generate_one(prompt, model, duration, aspect, task_id)
            materials[i]["percent"] = 100
            materials[i]["status"] = "done" if path else "failed"
        except Exception as e:  # noqa: BLE001
            logger.error(f"KlingAI clip {i + 1} failed: {e}")
            path = None
            materials[i]["status"] = "failed"
        _publish(task_id, materials)
        return i, path

    with ThreadPoolExecutor(max_workers=min(4, n)) as ex:
        futures = [ex.submit(_one, i, p) for i, p in enumerate(clip_prompts)]
        for fut in as_completed(futures):
            i, path = fut.result()
            results[i] = path

    paths = [p for p in results if p]
    logger.success(f"generated {len(paths)}/{n} KlingAI clips")
    return paths


def _generate_one(prompt, model, duration, aspect, task_id) -> str:
    submit = requests.post(
        f"{FAL_QUEUE}/{model}",
        headers=_headers(),
        json={"prompt": prompt, "duration": duration, "aspect_ratio": aspect},
        timeout=60,
    )
    submit.raise_for_status()
    job = submit.json()
    status_url = job.get("status_url")
    response_url = job.get("response_url")
    if not status_url or not response_url:
        logger.error(f"unexpected fal submit response: {str(job)[:200]}")
        return ""

    deadline = time.time() + 600  # Kling can take a few minutes
    while time.time() < deadline:
        s = requests.get(status_url, headers=_headers(), timeout=30)
        s.raise_for_status()
        status = s.json().get("status")
        if status == "COMPLETED":
            break
        if status in ("FAILED", "ERROR"):
            logger.error(f"KlingAI job failed: {s.text[:200]}")
            return ""
        time.sleep(5)
    else:
        logger.error("KlingAI job timed out")
        return ""

    res = requests.get(response_url, headers=_headers(), timeout=60)
    res.raise_for_status()
    video = res.json().get("video") or {}
    video_url = video.get("url")
    if not video_url:
        logger.error(f"no video url in KlingAI result: {res.text[:200]}")
        return ""
    return _download(video_url)


def _download(url: str) -> str:
    save_dir = utils.storage_dir("cache_videos")
    os.makedirs(save_dir, exist_ok=True)
    path = os.path.join(save_dir, f"kling-{utils.md5(url.split('?')[0])}.mp4")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    with requests.get(url, timeout=(60, 300), stream=True) as r:
        r.raise_for_status()
        with open(path, "wb") as f:
            for chunk in r.iter_content(262144):
                if chunk:
                    f.write(chunk)
    return path if os.path.exists(path) and os.path.getsize(path) > 0 else ""
