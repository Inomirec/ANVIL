"""Монтаж: кадр под иглой и сборка готового файла."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import re
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from .. import paths
from ..core import binaries, compose, pipeline
from ..models import ComposeBuildRequest, ComposeDraftRequest, ComposeFrameRequest
from . import media

router = APIRouter(prefix="/api/compose", tags=["compose"])


@router.post("/frame")
async def frame(request: ComposeFrameRequest) -> Response:
    """Отдаёт кадр композиции в запрошенный момент.

    Картинка возвращается прямо в ответе, а не ссылкой: игла ходит часто, и
    складывать под каждый её сдвиг файл в кэш — значит копить мусор ради
    картинки, которая нужна полсекунды. Просчёт занимает около десятой доли
    секунды, потому что в команду попадают только клипы под иглой.
    """
    try:
        project = await compose.prepare(request.project)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc

    if not project.duration:
        raise HTTPException(400, "На таймлайне пусто")

    # Свой файл на каждый запрос: два кадра могут считаться одновременно, и
    # общее имя означало бы, что один затирает другой на полуслове.
    handle, name = tempfile.mkstemp(suffix=".jpg", prefix="sgh-frame-")
    import os

    os.close(handle)
    target = Path(name)
    try:
        args = compose.build_frame(project, target, request.at, request.preview_width)
        process = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            creationflags=binaries.CREATE_NO_WINDOW,
            env=binaries.subprocess_env(),
        )
        _, err = await process.communicate()
        if process.returncode != 0 or not target.exists() or not target.stat().st_size:
            detail = err.decode("utf-8", "replace").strip().splitlines()
            raise HTTPException(
                500, "Не удалось собрать кадр: " + (detail[0] if detail else "неизвестно")
            )
        data = await asyncio.to_thread(target.read_bytes)
    finally:
        target.unlink(missing_ok=True)

    return Response(content=data, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


#: Где лежат черновики просмотра и сколько их держим.
_DRAFT_KEEP = 12
#: Пока собирается один кусок, следующий ждёт: иначе десяток ffmpeg разом
#: положит машину, ради которой всё это и затевалось.
_draft_lock = asyncio.Lock()
#: Имя черновика задаём сами — на вход принимаем только такое.
_DRAFT_NAME = re.compile(r"[0-9a-f]{20}\.mp4")


def _draft_dir() -> Path:
    directory = paths.data_dir() / "compose"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _prune_drafts(directory: Path) -> None:
    files = sorted(directory.iterdir(), key=lambda item: item.stat().st_mtime, reverse=True)
    for stale in files[_DRAFT_KEEP:]:
        with contextlib.suppress(OSError):
            stale.unlink()


@router.post("/draft")
async def draft(request: ComposeDraftRequest) -> dict:
    """Собирает кусок монтажа для просмотра и отдаёт ссылку на него.

    Готовый кусок кэшируется по содержимому монтажа и границам отрезка:
    человек нажимает «играть» на одном и том же месте по многу раз, и
    пересобирать одно и то же незачем.
    """
    try:
        project = await compose.prepare(request.project)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc

    if not project.duration:
        raise HTTPException(400, "На таймлайне пусто")

    at = min(request.at, project.duration)
    span = min(request.span, max(project.duration - at, 0.0))
    if span <= 0:
        raise HTTPException(400, "Дальше конца монтажа смотреть нечего")

    stamp = f"{project.model_dump_json()}|{at:.3f}|{span:.3f}|{request.height}"
    key = hashlib.sha1(stamp.encode("utf-8")).hexdigest()[:20]
    target = _draft_dir() / f"{key}.mp4"

    if not target.exists():
        async with _draft_lock:
            # Пока ждали очереди, соседний запрос мог всё собрать за нас.
            if not target.exists():
                width = round(request.height * project.width / project.height)
                args = compose.build_segment(
                    project, target, at=at, span=span,
                    width=width, height=request.height,
                )
                process = await asyncio.create_subprocess_exec(
                    *args,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                    creationflags=binaries.CREATE_NO_WINDOW,
                    env=binaries.subprocess_env(),
                )
                _, err = await process.communicate()
                if process.returncode != 0 or not target.exists():
                    target.unlink(missing_ok=True)
                    detail = err.decode("utf-8", "replace").strip().splitlines()
                    raise HTTPException(
                        500,
                        "Не удалось собрать просмотр: "
                        + (detail[0] if detail else "неизвестно"),
                    )
                _prune_drafts(target.parent)

    return {
        "url": f"/api/compose/draft/{target.name}",
        "at": at,
        "span": span,
        "size": target.stat().st_size,
    }


@router.get("/draft/{name}")
async def draft_file(name: str, request: Request) -> Response:
    """Отдаёт собранный черновик. Только из своей папки и только по имени.

    Отвечаем и на запросы диапазона: без них плеер не умеет перематывать, а
    при смене куска он запрашивает файл именно так.
    """
    if not _DRAFT_NAME.fullmatch(name):
        raise HTTPException(404, "Нет такого просмотра")
    target = _draft_dir() / name
    if not target.is_file():
        raise HTTPException(404, "Просмотр уже удалён")
    return media.ranged_file(target, request)


@router.post("/build")
async def build(request: ComposeBuildRequest) -> dict:
    """Ставит монтаж в очередь сборки."""
    try:
        project = await compose.prepare(request.project)
    except FileNotFoundError as exc:
        raise HTTPException(400, str(exc)) from exc

    if not project.duration:
        raise HTTPException(400, "На таймлайне пусто — нечего собирать")

    try:
        job = pipeline.submit_compose(request, project)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return job.to_dict()
