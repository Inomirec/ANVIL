"""Монтаж: кадр под иглой и сборка готового файла."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import os
import json
import re
import tempfile
import time
import urllib.parse
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from .. import config, paths
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

    # Выравнивание громкости всего монтажа — только в готовом файле: в кусках
    # оно подстраивалось бы заново на каждом стыке, и громкость прыгала.
    project.loudnorm = False

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
        await compose.prepare_fills(
            project, request.preview_width, preview_height, at=request.at, span=0.05
        )
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
#: Сорок кусков по 12 секунд, у каждого два файла (видео и звук), — восемь
#: минут монтажа: всё, что отмечено на линейке как собранное, должно и правда
#: лежать в запасе.
_DRAFT_KEEP = 80
#: Версия сборки черновиков. Меняется, когда меняется то, как собирается
#: кусок, — иначе просмотр брал бы из запаса куски, собранные по-старому.
_DRAFT_VERSION = "9"
#: Пока собирается один кусок, следующий ждёт: иначе десяток ffmpeg разом
#: положит машину, ради которой всё это и затевалось.
_draft_lock = asyncio.Lock()
#: Имя черновика задаём сами — на вход принимаем только такое.
_DRAFT_NAME = re.compile(r"[0-9a-f]{20}\.(?:mp4|wav)")


def _draft_dir() -> Path:
    directory = paths.data_dir() / "compose"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _prune_drafts(directory: Path) -> None:
    files = sorted(directory.iterdir(), key=lambda item: item.stat().st_mtime, reverse=True)
    for stale in files[_DRAFT_KEEP:]:
        with contextlib.suppress(OSError):
            stale.unlink()


async def _draft_sound(video: Path, span: float) -> Path | None:
    """Звук куска отдельным файлом, ровно ``span`` секунд.

    Окно склеивает звук соседних кусков само, с точностью до отсчёта: у
    звука внутри MP4 в начале лежит запас кодировщика, и при смене видео на
    стыке выходил провал. Несжатый звук нужной длины ложится встык без щели.
    Звука в куске нет — ``None``.
    """
    target = video.with_suffix(".wav")
    if target.exists():
        with contextlib.suppress(OSError):
            os.utime(target)
        return target
    process = await asyncio.create_subprocess_exec(
        binaries.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(video), "-map", "0:a:0", "-vn",
        "-af", "apad", "-t", f"{span:.3f}",
        "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", str(target),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        creationflags=binaries.CREATE_NO_WINDOW,
        env=binaries.subprocess_env(),
    )
    await process.wait()
    if process.returncode != 0 or not target.exists():
        target.unlink(missing_ok=True)
        return None
    return target


@router.post("/draft")
async def draft(request: ComposeDraftRequest, http: Request) -> dict:
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

    # Выравнивание громкости всего монтажа — только в готовом файле: в кусках
    # оно подстраивалось бы заново на каждом стыке, и громкость прыгала.
    project.loudnorm = False

    if not total:
        raise HTTPException(400, "На таймлайне пусто")

    at = min(request.at, total)
    span = min(request.span, max(total - at, 0.0))
    if span <= 0:
        raise HTTPException(400, "Дальше конца монтажа смотреть нечего")

    # Номер версии сборки — в ключе: исправленная сборка не должна брать из
    # запаса куски, собранные прежней (с пропавшим кадром на стыке).
    stamp = f"{_DRAFT_VERSION}|{project.model_dump_json()}|{at:.3f}|{span:.3f}|{request.height}"
    key = hashlib.sha1(stamp.encode("utf-8")).hexdigest()[:20]
    target = _draft_dir() / f"{key}.mp4"

    if target.exists():
        # Кусок снова понадобился — он свежий: чистка убирает давно не нужные,
        # а не давно собранные.
        with contextlib.suppress(OSError):
            os.utime(target)
    else:
        async with _draft_lock:
            # Пока ждали очереди, окно могло передумать: просмотр остановили
            # или начали с другого места. Брошенный кусок не собираем — иначе
            # новый просмотр ждал бы, пока доделаются никому не нужные.
            if not target.exists() and await http.is_disconnected():
                raise HTTPException(409, "Кусок больше не нужен")
            # Пока ждали очереди, соседний запрос мог всё собрать за нас.
            if not target.exists():
                width = round(request.height * project.width / project.height)
                await compose.prepare_fills(project, width, request.height, at=at, span=span)
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
                # Окно отозвало запрос посреди сборки — останавливаем ffmpeg.
                async def watch() -> None:
                    while process.returncode is None:
                        await asyncio.sleep(0.25)
                        if await http.is_disconnected():
                            with contextlib.suppress(ProcessLookupError):
                                process.kill()
                            return

                watcher = asyncio.create_task(watch())
                try:
                    _, err = await process.communicate()
                finally:
                    watcher.cancel()
                if process.returncode != 0 or not target.exists():
                    target.unlink(missing_ok=True)
                    if await http.is_disconnected():
                        raise HTTPException(409, "Кусок больше не нужен")
                    detail = err.decode("utf-8", "replace").strip().splitlines()
                    raise HTTPException(
                        500,
                        "Не удалось собрать просмотр: "
                        + (detail[0] if detail else "неизвестно"),
                    )
                _prune_drafts(target.parent)

    sound = await _draft_sound(target, span)
    return {
        "url": f"/api/compose/draft/{target.name}",
        "audio": f"/api/compose/draft/{sound.name}" if sound else None,
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
        # Каких прямых кавычек нет в шрифте и чем их заменит сборка.
        "quotes": await asyncio.to_thread(fonts.quote_swaps, path),
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


#: Самая длинная запись, которую примем: WAV 48 кГц стерео весит около
#: 660 МБ в час. Больше — это уже не запись с микрофона, а ошибка.
_RECORD_LIMIT = 2 * 1024 * 1024 * 1024


def default_record_folder() -> Path:
    """Куда класть записи голоса, если человек не выбрал папку сам."""
    return Path(config.load().resolved_workspace()) / "Записи"


def _allow_folder(folder: Path) -> None:
    """Пускает папку записей в рабочие, если её там нет.

    Клип монтажа читается только из рабочих папок. Папку для записей человек
    выбрал сам — значит, она его. Добавляем её в список проверки путей, но
    медиатеку на неё не переключаем: он сейчас монтирует, а не листает файлы.
    """
    if fsutil.is_allowed(folder):
        return
    settings = config.load()
    resolved = str(folder.resolve())
    workspaces = [item for item in settings.workspaces if item != resolved]
    workspaces.insert(1 if workspaces else 0, resolved)
    config.update({"workspaces": workspaces[:8]})


@router.post("/record")
async def record(request: Request, folder: str = "") -> dict[str, str]:
    """Сохраняет запись с микрофона как есть — WAV без сжатия.

    Окно присылает готовый WAV: звук снимается с микрофона отсчётами, без
    сжатия и без обработки браузером. Файл принимаем потоком, сразу на диск:
    часовая запись весит сотни мегабайт, и держать её в памяти незачем.
    Папку выбирает человек (своя у каждого проекта), иначе — «Записи» в
    рабочей папке.
    """
    target = Path(folder).expanduser() if folder else default_record_folder()
    try:
        await asyncio.to_thread(target.mkdir, parents=True, exist_ok=True)
        await asyncio.to_thread(_allow_folder, target)
    except OSError as exc:
        raise HTTPException(400, f"Не удалось открыть папку для записей: {exc}") from exc
    if not fsutil.is_allowed(target):
        raise HTTPException(400, "Папка для записей недоступна")

    stamp = time.strftime("Запись %Y-%m-%d %H-%M-%S")
    output = fsutil.unique_path(target / f"{stamp}.wav", reserve=True)
    part = output.with_name(f".{output.name}.part")
    size = 0
    try:
        handle = await asyncio.to_thread(part.open, "wb")
        try:
            async for chunk in request.stream():
                if not chunk:
                    continue
                if size == 0 and not chunk.startswith(b"RIFF"):
                    raise HTTPException(400, "Окно прислало не WAV")
                size += len(chunk)
                if size > _RECORD_LIMIT:
                    raise HTTPException(413, "Запись слишком длинная")
                await asyncio.to_thread(handle.write, chunk)
        finally:
            await asyncio.to_thread(handle.close)
        if size <= 44:
            raise HTTPException(400, "Запись пустая — микрофон ничего не передал")
        await asyncio.to_thread(part.replace, output)
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    finally:
        fsutil.release_path(output)
    return {"path": str(output)}


@router.get("/record-folder")
async def record_folder() -> dict[str, str]:
    """Папка записей по умолчанию — её показывают, когда спрашивают, куда писать."""
    return {"path": str(default_record_folder())}


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
