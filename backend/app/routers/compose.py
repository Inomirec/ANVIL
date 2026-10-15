"""Монтаж: кадр под иглой и сборка готового файла."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import os
import json
import re
import tempfile
import urllib.parse
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from .. import paths
from ..core import binaries, compose, fonts, fsutil, pipeline, trash
from ..models import (
    ComposeBuildRequest,
    ComposeCheckRequest,
    ComposeFindRequest,
    ComposeDraftRequest,
    ComposeFrameRequest,
    ComposeProjectFile,
    ComposeSnapshotRequest,
    StabilizeRequest,
)
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
    # Длину считаем до проверки файлов: пропавший клип из кадра выпадает, но
    # место на таймлайне он занимает по-прежнему.
    total = request.project.duration
    lost: list[str] = []
    try:
        project = await compose.prepare(request.project, skip_missing=True, lost=lost)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc

    if not total:
        raise HTTPException(400, "На таймлайне пусто")

    # Свой файл на каждый запрос: два кадра могут считаться одновременно, и
    # общее имя означало бы, что один затирает другой на полуслове.
    handle, name = tempfile.mkstemp(suffix=".jpg", prefix="sgh-frame-")
    import os

    os.close(handle)
    target = Path(name)
    try:
        # Заливки со скруглением, рамкой и тенью рисуются заранее и отдельно:
        # внутри сборки команды ждать ffmpeg было бы нельзя.
        preview_height = round(request.preview_width * project.height / project.width)
        await compose.prepare_fills(project, request.preview_width, preview_height)
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

    return Response(
        content=data,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "no-store",
            # Какие файлы пропали — окно откроет по ним список пропавших.
            "X-Sgh-Missing": urllib.parse.quote(json.dumps(lost, ensure_ascii=False)),
        },
    )


#: Где лежат черновики просмотра и сколько их держим.
#: Сорок кусков по 12 секунд — восемь минут монтажа: всё, что отмечено на
#: линейке как собранное, должно и правда лежать в запасе.
_DRAFT_KEEP = 40
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
    # Длина — по всем клипам, и по пропавшим тоже: иначе удалённый файл
    # «укорачивал» монтаж, и просмотр отвечал «дальше конца смотреть нечего».
    total = request.project.duration
    lost: list[str] = []
    try:
        project = await compose.prepare(request.project, skip_missing=True, lost=lost)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc

    if not total:
        raise HTTPException(400, "На таймлайне пусто")

    at = min(request.at, total)
    span = min(request.span, max(total - at, 0.0))
    if span <= 0:
        raise HTTPException(400, "Дальше конца монтажа смотреть нечего")

    stamp = f"{project.model_dump_json()}|{at:.3f}|{span:.3f}|{request.height}"
    key = hashlib.sha1(stamp.encode("utf-8")).hexdigest()[:20]
    target = _draft_dir() / f"{key}.mp4"

    if target.exists():
        # Кусок снова понадобился — он свежий: чистка убирает давно не нужные,
        # а не давно собранные.
        with contextlib.suppress(OSError):
            os.utime(target)
    else:
        async with _draft_lock:
            # Пока ждали очереди, соседний запрос мог всё собрать за нас.
            if not target.exists():
                width = round(request.height * project.width / project.height)
                await compose.prepare_fills(project, width, request.height)
                args = compose.build_segment(
                    project, target, at=at, span=span,
                    width=width, height=request.height, preview=True,
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
        "missing": lost,
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


#: Расширение файла монтажа. Внутри обычный JSON — его можно открыть
#: блокнотом, но своё расширение не даёт спутать его с чем-то ещё.
_PROJECT_SUFFIX = ".sghproj"


def _projects_dir() -> Path:
    directory = paths.data_dir() / "projects"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _project_path(name: str) -> Path:
    """Путь к файлу проекта по его имени.

    Имя приходит от человека, поэтому чистим его тем же способом, что и имена
    результатов, и приклеиваем расширение сами: так из имени не получится
    выйти в чужую папку.
    """
    stem = fsutil.sanitize_name(name, fallback="Монтаж")
    return _projects_dir() / f"{stem}{_PROJECT_SUFFIX}"


@router.get("/projects")
async def projects() -> dict:
    """Список сохранённых монтажей, новые сверху."""
    directory = _projects_dir()

    def collect() -> list[dict]:
        found = []
        for item in directory.glob(f"*{_PROJECT_SUFFIX}"):
            try:
                data = json.loads(item.read_text("utf-8"))
            except (OSError, ValueError):
                continue
            tracks = data.get("tracks") or []
            found.append({
                "name": item.stem,
                "savedAt": item.stat().st_mtime,
                "clips": sum(len(track.get("clips") or []) for track in tracks),
            })
        found.sort(key=lambda item: item["savedAt"], reverse=True)
        return found

    return {"folder": str(directory), "projects": await asyncio.to_thread(collect)}


@router.post("/projects")
async def save_project(request: ComposeProjectFile) -> dict:
    """Сохраняет монтаж в файл под выбранным именем.

    Содержимое не разбираем: то, что прислал интерфейс, так и ложится в файл.
    Это нарочно — в монтаже есть поля, нужные только окну (масштаб таймлайна,
    вид шины), и заставлять сервер знать о них незачем.
    """
    target = _project_path(request.name)
    body = json.dumps(
        {"format": "sigame-helper-compose", "version": 1, **request.project},
        ensure_ascii=False,
        indent=1,
    )
    await asyncio.to_thread(target.write_text, body, "utf-8")
    return {"name": target.stem, "path": str(target)}


@router.get("/projects/{name}")
async def open_project(name: str) -> dict:
    """Отдаёт сохранённый монтаж целиком."""
    target = _project_path(name)
    if not target.is_file():
        raise HTTPException(404, "Такого монтажа нет — возможно, файл удалили")
    try:
        data = json.loads(await asyncio.to_thread(target.read_text, "utf-8"))
    except (OSError, ValueError) as exc:
        raise HTTPException(400, "Файл монтажа испорчен и не читается") from exc
    return {"name": target.stem, "project": data}


class ProjectRename(BaseModel):
    to: str


@router.post("/projects/{name}/rename")
async def rename_project(name: str, request: ProjectRename) -> dict:
    """Переименовывает сохранённый проект — это просто другое имя файла.

    Занятое имя не трогаем: молча затереть другой проект хуже, чем попросить
    придумать другое.
    """
    source = _project_path(name)
    if not source.is_file():
        raise HTTPException(404, "Такого проекта нет — возможно, файл удалили")
    target = _project_path(request.to)
    if target == source:
        return {"name": target.stem}
    if target.exists():
        raise HTTPException(409, f"Проект «{target.stem}» уже есть — выберите другое имя")
    await asyncio.to_thread(source.rename, target)
    return {"name": target.stem}


@router.delete("/projects/{name}")
async def remove_project(name: str) -> dict:
    """Убирает сохранённый монтаж.

    Файл уходит в корзину — как и всё остальное, что программа удаляет: часа
    работы человек лишаться не должен из-за промаха по кнопке. Если корзина
    недоступна, удаляем обычным способом.
    """
    target = _project_path(name)
    if not target.is_file():
        raise HTTPException(404, "Такого монтажа нет")
    try:
        await asyncio.to_thread(trash.to_trash, target)
    except OSError:
        await asyncio.to_thread(target.unlink)
    return {"ok": True}


@router.get("/fonts")
async def font_list() -> dict[str, object]:
    """Шрифты, установленные в системе.

    Читается это из реестра Windows, поэтому уходит в отдельный поток: список
    длинный, и на слабой машине обход задержал бы все остальные запросы.
    """
    families = await asyncio.to_thread(fonts.families)
    return {"fonts": [item.to_dict() for item in families]}


@router.get("/fonts/face")
async def font_face(name: str, bold: bool = False, italic: bool = False) -> dict[str, object]:
    """Какой файл шрифта возьмёт сборка и какой у него шаг строк.

    Окно рисует выделенную надпись само и должно брать ровно тот же файл, что
    и программа: по имени браузер находил не всё — «Pribambas-Regular» он не
    знал и молча подставлял Arial. Отсюда ссылка на сам файл и высота строки
    из него же, чтобы строки на экране и в файле стояли одинаково.
    """
    path = await asyncio.to_thread(fonts.path_for, name, bold, italic)
    if not path:
        raise HTTPException(404, "Шрифтов в системе не нашлось")
    ratio = await asyncio.to_thread(fonts.line_height, path)
    return {
        "key": hashlib.sha1(path.encode("utf-8")).hexdigest()[:12],
        "url": (
            "/api/compose/fonts/file?"
            + urllib.parse.urlencode({"name": name, "bold": str(bold).lower(), "italic": str(italic).lower()})
        ),
        "lineHeight": round(ratio, 4),
    }


@router.get("/fonts/file")
async def font_file(name: str, bold: bool = False, italic: bool = False) -> FileResponse:
    """Сам файл шрифта — только из тех, что установлены в системе.

    Путь берётся не из запроса, а из списка шрифтов Windows: отдать через
    эту дверь что-нибудь, кроме шрифта, нельзя.
    """
    path = await asyncio.to_thread(fonts.path_for, name, bold, italic)
    if not path:
        raise HTTPException(404, "Шрифт не найден")
    kind = "font/otf" if path.lower().endswith(".otf") else "font/ttf"
    # Файл шрифта не меняется, пока он установлен, — пусть окно держит его.
    return FileResponse(path, media_type=kind, headers={"Cache-Control": "max-age=3600"})


@router.post("/stabilize")
async def stabilize_status(request: StabilizeRequest) -> dict[str, object]:
    """Готова ли ровная копия ролика — для карточки стабилизатора.

    Если копии нет и она не считается, начинает считать: карточка спрашивает
    сразу, как только эффект добавили, не дожидаясь кадра.
    """
    from ..core import stabilize

    try:
        path = fsutil.safe_path(request.source)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc
    settings = stabilize.Settings.from_params(request.params)
    answer = stabilize.status(str(path), settings)
    if answer["state"] == "idle":
        stabilize.ready(str(path), settings)
        answer = stabilize.status(str(path), settings)
    return answer


@router.post("/check")
async def check(request: ComposeCheckRequest) -> dict[str, list[str]]:
    """Какие файлы монтажа пропали — для окна при открытии проекта."""
    return await asyncio.to_thread(compose.check_sources, request.sources)


@router.post("/find-near")
async def find_near(request: ComposeFindRequest) -> dict[str, dict[str, str]]:
    """Ищет остальные пропавшие файлы в папке, где нашёлся один из них."""
    return {"found": await asyncio.to_thread(compose.find_near, request.folder, request.sources)}


@router.post("/snapshot")
async def snapshot(request: ComposeSnapshotRequest) -> dict:
    """Сохраняет кадр монтажа под иглой картинкой — обычной задачей."""
    try:
        project = await compose.prepare(request.project)
    except FileNotFoundError as exc:
        raise HTTPException(400, str(exc)) from exc

    if not project.duration:
        raise HTTPException(400, "На таймлайне пусто — нечего снимать")

    try:
        job = pipeline.submit_compose_frame(request, project)
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return job.to_dict()


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
