"""Монтаж: кадр под иглой и сборка готового файла."""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from ..core import binaries, compose, pipeline
from ..models import ComposeBuildRequest, ComposeFrameRequest

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
