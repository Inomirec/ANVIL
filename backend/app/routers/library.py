"""Медиатека: обход рабочей папки, сведения о файлах, миниатюры."""

from __future__ import annotations

import asyncio

import os
from pathlib import Path
from urllib.parse import quote
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from .. import config
from ..core import filmstrip, fsutil, scenes, thumbs, trash, waveform
from ..core.events import bus
from ..core.probe import moves, probe
from ..models import PathRequest, PathsRequest, RenameRequest

router = APIRouter(prefix="/api/library", tags=["library"])


@router.get("")
async def list_library(
    root: str | None = None,
    kind: str = Query(default="all", pattern="^(all|video|audio|image)$"),
    recursive: bool = True,
    search: str | None = None,
) -> dict[str, Any]:
    """Список медиафайлов рабочей папки."""
    settings = config.load()
    target = Path(root or settings.resolved_workspace()).expanduser()

    if not target.exists():
        return {
            "root": str(target),
            "workspace": settings.resolved_workspace(),
            "relative": "",
            "parent": None,
            "folders": [],
            "exists": False,
            "files": [],
            "counts": {"all": 0, "video": 0, "audio": 0, "image": 0},
            "totalSize": 0,
        }

    def collect() -> tuple[list[dict], list[dict], dict[str, int]]:
        """Обход папки. Выполняется в отдельном потоке — см. ниже."""
        # Обходим один раз и фильтруем в памяти: раньше при выбранном типе
        # или поиске папка обходилась дважды.
        everything = fsutil.scan_directory(target, recursive=True)
        counts = {"all": len(everything), "video": 0, "audio": 0, "image": 0}
        for item in everything:
            counts[item["kind"]] = counts.get(item["kind"], 0) + 1

        found = everything
        if not recursive:
            # В режиме навигации показываем только файлы самой папки.
            here = str(target)
            found = [item for item in found if item["folder"] == here]
        if kind != "all":
            found = [item for item in found if item["kind"] == kind]
        if search:
            needle = search.casefold()
            found = [item for item in found if needle in item["name"].casefold()]
        found.sort(key=lambda item: item["modified"], reverse=True)

        # Подпапки нужны только в режиме навигации: в «плоском» виде файлы
        # из них и так все показаны.
        subfolders = [] if recursive else fsutil.list_folders(target)
        return found, subfolders, counts

    # Обход диска — работа не быстрая: на папке в несколько тысяч файлов он
    # занимает секунды. Прямо в обработчике он остановил бы весь сервер, и
    # соседние запросы (удаление, обновление списка) просто ждали бы его
    # молча. Поэтому уводим в отдельный поток.
    files, folders, counts = await asyncio.to_thread(collect)

    workspace = Path(settings.resolved_workspace()).expanduser()
    try:
        relative = str(target.relative_to(workspace))
    except ValueError:
        relative = ""

    return {
        "root": str(target),
        "workspace": str(workspace),
        "relative": "" if relative == "." else relative,
        "parent": str(target.parent) if target != workspace and target.parent != target else None,
        "folders": folders,
        "exists": True,
        "files": files,
        "counts": counts,
        "totalSize": sum(item["size"] for item in files),
    }


@router.get("/kind")
async def path_kind(path: str) -> dict[str, str]:
    """Папка это или файл.

    Нужно там, где путь приходит извне — например файл перетащили в окно.
    Папку надо открывать списком, а не пытаться показать её плеером.
    """
    # Рабочей папкой путь ещё не стал — его только что перетащили в окно,
    # поэтому обычную проверку не зовём: ответ говорит лишь о том, что это,
    # и ничего не открывает.
    try:
        target = Path(path).expanduser().resolve()
    except OSError as exc:
        raise HTTPException(404, f"Некорректный путь: {path}") from exc
    if target.is_dir():
        return {"kind": "folder", "path": str(target)}
    if target.exists():
        return {"kind": "file", "path": str(target)}
    return {"kind": "missing", "path": str(target)}


@router.post("/moving")
async def moving(request: PathsRequest) -> dict[str, list[str]]:
    """Какие из картинок движутся — по заголовкам файлов.

    Спрашивают перед пачкой, чтобы не пугать вопросом о движении, когда
    движущихся среди отмеченных нет. Чтение — несколько байт на файл, но на
    сотне файлов с медленного диска это заметно, поэтому вне обработчика.
    """

    def check() -> list[str]:
        found: list[str] = []
        for path in request.paths:
            try:
                target = fsutil.safe_path(path)
            except (PermissionError, FileNotFoundError, ValueError):
                continue
            if target.is_file() and moves(target):
                found.append(path)
        return found

    return {"moving": await asyncio.to_thread(check)}


@router.get("/info")
async def file_info(path: str) -> dict[str, Any]:
    """Технические характеристики одного файла."""
    try:
        target = fsutil.safe_path(path)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc

    # Папка сюда попадать не должна: у неё нет ни расширения, ни дорожек, и
    # редактор показывал по ней плашку «формат „.“ не показывается».
    if target.is_dir():
        raise HTTPException(400, "Это папка, а не файл — откройте её в медиатеке")

    kind = fsutil.media_kind(target)
    payload: dict[str, Any] = {
        "path": str(target),
        "name": target.name,
        "kind": kind,
        "size": target.stat().st_size,
        "modified": target.stat().st_mtime,
        "ext": target.suffix.lstrip(".").lower(),
        "playable": fsutil.browser_playable(target),
        "folder": str(target.parent),
    }
    try:
        info = await probe(target)
        payload["media"] = info.to_dict()
    except (RuntimeError, OSError) as exc:
        payload["media"] = None
        payload["probeError"] = str(exc)
    return payload


@router.get("/thumbnail")
async def thumbnail(path: str) -> FileResponse:
    """Миниатюра файла (генерируется и кэшируется на диске)."""
    try:
        target = fsutil.safe_path(path)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc

    generated = await thumbs.get_or_create(target)
    if not generated:
        raise HTTPException(404, "Миниатюра недоступна для этого файла")
    return FileResponse(
        generated,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/filmstrip")
async def video_filmstrip(path: str, frames: int = filmstrip.DEFAULT_FRAMES) -> dict[str, Any]:
    """Лента кадров для видеодорожки таймлайна."""
    try:
        target = fsutil.safe_path(path)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc

    if fsutil.media_kind(target) != "video":
        raise HTTPException(400, "Лента кадров есть только у видео")

    try:
        strip = await filmstrip.build(target, frames)
    except (RuntimeError, OSError) as exc:
        raise HTTPException(500, f"Не удалось собрать ленту кадров: {exc}") from exc
    if not strip:
        raise HTTPException(404, "У файла нет видеодорожки")

    return {
        "url": f"/api/library/filmstrip/image?path={quote(str(target))}&frames={strip.frames}",
        "frames": strip.frames,
        "tileWidth": strip.tile_width,
        "tileHeight": strip.tile_height,
    }


@router.get("/filmstrip/image")
async def video_filmstrip_image(path: str, frames: int = filmstrip.DEFAULT_FRAMES) -> FileResponse:
    """Сам спрайт с кадрами (одна картинка на всю дорожку)."""
    try:
        target = fsutil.safe_path(path)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc

    strip = await filmstrip.build(target, frames)
    if not strip:
        raise HTTPException(404, "Лента кадров недоступна")
    return FileResponse(
        strip.path,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/scenes")
async def video_scenes(path: str, large: bool = False) -> dict[str, Any]:
    """Склейки ролика и кадры по сценам — для ленты на клипе и шага по сценам."""
    try:
        target = fsutil.safe_path(path)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc
    if fsutil.media_kind(target) != "video":
        raise HTTPException(400, "Сцены есть только у видео")
    try:
        found = await scenes.build(target, large)
    except (RuntimeError, OSError) as exc:
        raise HTTPException(500, f"Не удалось найти сцены: {exc}") from exc
    if not found:
        raise HTTPException(404, "У файла нет видеодорожки")
    return {
        **found.as_json(),
        # Имя картинки меняется вместе с файлом — старую браузер не возьмёт.
        "url": f"/api/library/scenes/image?path={quote(str(target))}&large={int(large)}&v={found.sprite.stem[:12]}",
    }


@router.get("/scenes/image")
async def video_scenes_image(path: str, large: int = 0) -> FileResponse:
    """Сетка кадров по сценам одной картинкой."""
    try:
        target = fsutil.safe_path(path)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc
    found = scenes.cached(target, scenes.LARGE_HEIGHT if large else scenes.TILE_HEIGHT)
    if not found:
        raise HTTPException(404, "Кадры ещё не готовы")
    return FileResponse(
        found.sprite,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/waveform")
async def audio_waveform(path: str, buckets: int = waveform.DEFAULT_BUCKETS) -> dict[str, Any]:
    """Огибающая звука для таймлайна: список пиков от 0 до 1."""
    try:
        target = fsutil.safe_path(path)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc

    if fsutil.media_kind(target) not in {"audio", "video"}:
        raise HTTPException(400, "У этого файла нет звуковой дорожки")

    try:
        return await waveform.peaks(target, max(120, min(buckets, 12000)))
    except (RuntimeError, OSError) as exc:
        raise HTTPException(500, f"Не удалось построить звуковую волну: {exc}") from exc


@router.post("/delete")
async def delete_file(payload: PathRequest) -> dict[str, Any]:
    """Убирает файл в корзину — как это делает проводник.

    Безвозвратно не удаляем: промахнуться по кнопке легко, а вернуть файл
    из корзины человек умеет и без нас. Если корзины нет (не Windows),
    честно говорим об этом, а не удаляем молча навсегда.
    """
    try:
        target = fsutil.safe_path(payload.path)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc
    if target.is_dir():
        raise HTTPException(400, "Удаление папок через интерфейс не поддерживается")
    # Файл может быть ещё занят: плеер только что отпустил поток, а Windows
    # освобождает его не мгновенно. Пробуем несколько раз, прежде чем ругаться.
    last: OSError | None = None
    for attempt in range(6):
        try:
            # Обращение к оболочке Windows блокирующее — в поток его.
            await asyncio.to_thread(trash.to_trash, target)
            last = None
            break
        except FileNotFoundError:
            last = None
            break
        except OSError as exc:
            last = exc
            await asyncio.sleep(0.15 * (attempt + 1))
    if last is not None:
        raise HTTPException(
            500,
            "Файл занят другой программой — закройте его и попробуйте снова "
            f"({last})",
        )
    bus.publish("library.changed", {"path": str(target.parent)})
    return {"ok": True}


@router.post("/rename")
async def rename_file(payload: RenameRequest) -> dict[str, Any]:
    try:
        target = fsutil.safe_path(payload.path)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc

    name = fsutil.sanitize_name(payload.new_name, fallback=target.stem)
    if not name:
        raise HTTPException(400, "Пустое имя файла")
    if not Path(name).suffix:
        name = f"{name}{target.suffix}"

    destination = fsutil.unique_path(target.parent / name)
    try:
        target.rename(destination)
    except OSError as exc:
        raise HTTPException(500, f"Не удалось переименовать: {exc}") from exc
    bus.publish("library.changed", {"path": str(destination.parent)})
    return {"ok": True, "path": str(destination)}
