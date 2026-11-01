"""Проигрывание удалённого видео до скачивания.

yt-dlp умеет отдать прямую ссылку на поток, но браузер по ней обычно ничего
не покажет: чужой сайт не разрешает воспроизведение с нашей страницы (CORS),
а многие плееры дополнительно проверяют заголовок Referer. Поэтому поток
идёт через наш же сервер — он подставляет нужные заголовки и честно
поддерживает Range, чтобы работала перемотка.

Ссылки не принимаются от браузера напрямую: сначала ``resolve`` разбирает
пользовательскую страницу и кладёт результат в реестр, а фронтенд получает
только короткий токен. Так через прокси нельзя попросить произвольный адрес.
"""

from __future__ import annotations

import asyncio
import contextlib
import http.client
import json
import re
import secrets
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from . import binaries, download
from .download import _common_args

#: Сколько живёт выданный токен потока.
TOKEN_TTL = 6 * 3600

#: Размер блока при перекачке.
CHUNK = 256 * 1024

#: Предпросмотр не обязан быть в исходном качестве — берём поток полегче,
#: чтобы перемотка не тормозила.
#: Потолок качества предпросмотра. Здесь не смотрят кино, а ищут границы
#: отрезка: чем легче поток, тем быстрее он открывается и перематывается.
#: Скачивается всё равно максимальное качество, это только для разметки.
PREVIEW_MAX_HEIGHT = 480

#: Качества предпросмотра из раздельных потоков — когда слитного такой высоты
#: нет (у YouTube слитный обычно один, 360p). Картинка и звук идут двумя
#: потоками, окно проигрывает их вместе.
SEPARATE_HEIGHTS = (480, 720)

#: Кодеки картинки по убыванию предпочтения: H.264 легче всех декодировать.
_VIDEO_CODECS = ("avc1", "vp9", "vp09", "av01")


@dataclass(slots=True)
class Stream:
    url: str
    #: Страница, с которой ссылка добыта: по ней ссылку можно получить заново.
    source: str = ""
    headers: dict[str, str] = field(default_factory=dict)
    created: float = field(default_factory=time.time)
    title: str = ""
    duration: float | None = None
    #: Что это за поток: «audio» — один звук (для волны), иначе высота кадра.
    #: По ней протухшая ссылка добывается заново ровно та же.
    pick: str = ""


_registry: dict[str, Stream] = {}


def _prune() -> None:
    deadline = time.time() - TOKEN_TTL
    for token in [t for t, s in _registry.items() if s.created < deadline]:
        _registry.pop(token, None)


def register(stream: Stream) -> str:
    _prune()
    token = secrets.token_urlsafe(16)
    _registry[token] = stream
    return token


def get(token: str) -> Stream | None:
    _prune()
    return _registry.get(token)


def _progressive(formats: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Дорожки, где видео и звук уже вместе, — все, что откроет браузер.

    Раздельные потоки (как у YouTube) один тег <video> не проиграет, а HLS
    браузер без сторонней библиотеки тоже не понимает. Поэтому для
    предпросмотра годится только «слитный» файл по обычному HTTP.
    """
    #: Контейнеры, которые встроенный плеер браузера открывает сам.
    playable_ext = {"mp4", "m4v", "webm", "mov", "ogv"}

    candidates: list[dict[str, Any]] = []
    for item in formats:
        protocol = str(item.get("protocol") or "")
        if not protocol.startswith("http") or "m3u8" in protocol or "dash" in protocol:
            continue
        if not item.get("url"):
            continue

        vcodec = item.get("vcodec")
        acodec = item.get("acodec")
        if vcodec == "none" or acodec == "none":
            # Явно раздельные дорожки: один тег <video> их не сведёт.
            continue
        if vcodec in (None, "unknown") or acodec in (None, "unknown"):
            # Обычная прямая ссылка на файл: yt-dlp не разбирал его содержимое,
            # но по расширению видно, что браузер справится.
            if str(item.get("ext") or "").lower() not in playable_ext:
                continue

        candidates.append(item)
    return candidates


def _pick_progressive(formats: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Поток для предпросмотра по умолчанию — не выше потолка, самый крупный."""
    candidates = _progressive(formats)
    if not candidates:
        return None

    def rank(item: dict[str, Any]) -> tuple[int, int]:
        height = item.get("height") or 0
        # Сначала то, что не выше потолка предпросмотра, — от большего к меньшему.
        within = 0 if height <= PREVIEW_MAX_HEIGHT else 1
        return (within, -height if within == 0 else height)

    candidates.sort(key=rank)
    return candidates[0]


def _video_only(formats: list[dict[str, Any]], height: int) -> dict[str, Any] | None:
    """Поток одной картинки нужной высоты — для качества выше слитного."""
    found = []
    for item in formats:
        protocol = str(item.get("protocol") or "")
        if not protocol.startswith("http") or "m3u8" in protocol or "dash" in protocol:
            continue
        if not item.get("url") or item.get("acodec") != "none" or int(item.get("height") or 0) != height:
            continue
        vcodec = str(item.get("vcodec") or "")
        rank = next((i for i, name in enumerate(_VIDEO_CODECS) if vcodec.startswith(name)), None)
        if rank is None or str(item.get("ext") or "") not in {"mp4", "webm"}:
            continue
        found.append((rank, item.get("tbr") or 1e9, item))
    found.sort(key=lambda entry: entry[:2])
    return found[0][2] if found else None


def _pick_audio(formats: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Самый лёгкий поток одного звука — по нему строится волна.

    Волне нужен весь звук ролика, а слитный поток с картинкой весит в разы
    больше: за звуком 24-минутной серии пришлось бы тянуть сотню мегабайт.
    """
    audio = [
        item for item in formats
        if item.get("vcodec") == "none"
        and item.get("acodec") not in (None, "none")
        and str(item.get("protocol") or "").startswith("http")
        and "m3u8" not in str(item.get("protocol") or "")
        and "dash" not in str(item.get("protocol") or "")
        and item.get("url")
    ]
    # Звук с пометкой drc — с выровненной громкостью: для волны он врёт.
    audio = [item for item in audio if "drc" not in str(item.get("format_id") or "")] or audio
    audio.sort(key=lambda item: item.get("abr") or item.get("tbr") or 1e9)
    return audio[0] if audio else None


async def resolve(url: str) -> dict[str, Any]:
    """Разбирает ссылку и, если получится, готовит поток для предпросмотра."""
    args = [
        binaries.require("yt-dlp"),
        "--dump-single-json",
        "--no-warnings",
        "--ignore-config",
        "--no-playlist",
        *_common_args(url),
        url,
    ]
    process = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=binaries.CREATE_NO_WINDOW,
        env=binaries.subprocess_env(),
    )
    out, err = await process.communicate()
    if process.returncode != 0:
        message = err.decode("utf-8", "replace").strip()
        raise RuntimeError(message.splitlines()[-1] if message else "yt-dlp не понял ссылку")

    data = json.loads(out.decode("utf-8", "replace") or "{}")
    formats = data.get("formats") or []
    chosen = _pick_progressive(formats)
    sound = _pick_audio(formats)

    result: dict[str, Any] = {
        "url": url,
        "title": data.get("title") or url,
        "uploader": data.get("uploader") or data.get("channel"),
        "duration": data.get("duration"),
        "thumbnail": data.get("thumbnail"),
        "extractor": data.get("extractor_key"),
        "previewToken": None,
        "previewHeight": None,
        "previewNote": None,
        #: Все качества предпросмотра, какие есть у ссылки: [{height, token,
        #: separate}]. У separate звук берётся из audioToken.
        "previewOptions": [],
        #: Поток одного звука для волны; нет — волна строится по предпросмотру.
        "audioToken": None,
    }

    if not chosen:
        has_hls = any("m3u8" in str(f.get("protocol") or "") for f in formats)
        result["previewNote"] = (
            "У этой ссылки нет слитного потока, который открывает браузер"
            + (" (только HLS)." if has_hls else ".")
            + " Скачайте черновик — и размечайте отрезок в обычном редакторе."
        )
        return result

    referer = download.referer_for(url)

    def enlist(item: dict[str, Any], pick: str) -> str:
        headers = {
            str(key): str(value)
            for key, value in (item.get("http_headers") or data.get("http_headers") or {}).items()
        }
        # Прокси ходит за файлом сам, поэтому Referer нужен и ему.
        if referer:
            headers.setdefault("Referer", referer)
        return register(
            Stream(
                url=str(item["url"]),
                source=url,
                headers=headers,
                title=str(result["title"]),
                duration=data.get("duration"),
                pick=pick,
            )
        )

    # Каждая высота — свой токен: человек выбирает качество предпросмотра в
    # окне разметки. Одинаковые высоты не повторяем — берём первую.
    options: dict[int, str] = {}
    for item in _progressive(formats):
        height = int(item.get("height") or 0)
        if height in options:
            continue
        options[height] = enlist(item, f"h{height}")
    height = int(chosen.get("height") or 0)
    result["previewToken"] = options.get(height) or enlist(chosen, f"h{height}")
    result["previewHeight"] = chosen.get("height")
    # Высоты, которых нет слитным потоком, — картинкой отдельно от звука.
    separate: dict[int, str] = {}
    if sound:
        for wanted in SEPARATE_HEIGHTS:
            video = None if wanted in options else _video_only(formats, wanted)
            if video:
                separate[wanted] = enlist(video, f"v{wanted}")
    listed = [{"height": key, "token": value, "separate": False} for key, value in options.items()]
    listed += [{"height": key, "token": value, "separate": True} for key, value in separate.items()]
    result["previewOptions"] = sorted(listed, key=lambda item: -int(item["height"]))
    if sound:
        result["audioToken"] = enlist(sound, "audio")
    return result


from .certs import ipv4_opener


def open_upstream(stream: Stream, range_header: str | None) -> tuple[Any, dict[str, str], int]:
    """Открывает соединение с источником, пробрасывая Range."""
    headers = dict(stream.headers)
    headers.setdefault("User-Agent", "Mozilla/5.0")
    # Заголовки от yt-dlp предназначены для загрузки страницы, а не файла:
    # с ними часть CDN отдаёт HTML вместо видео.
    headers.pop("Sec-Fetch-Mode", None)
    headers["Accept"] = "*/*"
    if range_header:
        headers["Range"] = range_header

    request = urllib.request.Request(stream.url, headers=headers)
    try:
        response = ipv4_opener().open(request, timeout=30)
    except urllib.error.HTTPError as exc:
        # 416 и подобное осмысленно передать клиенту как есть.
        return None, dict(exc.headers or {}), exc.code
    return response, dict(response.headers), response.status


async def refresh(stream: Stream) -> bool:
    """Добывает прямую ссылку заново.

    У YouTube и подобных ссылка на файл живёт несколько часов и привязана к
    сессии. Когда она протухает, источник отвечает 403 — раньше это доходило
    до человека как «источник оборвал поток», хотя видео никуда не делось.
    """
    if not stream.source:
        return False
    try:
        data = await resolve(stream.source)
    except Exception:
        return False

    # resolve заводит свои токены — они нам не нужны, забираем только ссылку
    # того же потока: звук — у звука, предпросмотр — той же высоты.
    tokens = [str(item["token"]) for item in data.get("previewOptions") or []]
    tokens += [str(data.get(key) or "") for key in ("previewToken", "audioToken")]
    if stream.pick == "audio":
        wanted = str(data.get("audioToken") or "")
    else:
        wanted = next(
            (
                str(item["token"])
                for item in data.get("previewOptions") or []
                if f"{'v' if item.get('separate') else 'h'}{item['height']}" == stream.pick
            ),
            str(data.get("previewToken") or ""),
        )
    fresh = _registry.get(wanted) if wanted else None
    for token in tokens:
        _registry.pop(token, None)
    if not fresh:
        return False

    stream.url = fresh.url
    stream.headers = fresh.headers
    stream.created = time.time()
    return True


def _range_start(headers: dict[str, str]) -> int:
    """С какого байта начинается тело ответа — по заголовку Content-Range."""
    match = re.search(r"bytes\s+(\d+)-", _header(headers, "content-range"))
    return int(match.group(1)) if match else 0


def _header(headers: dict[str, str], name: str) -> str:
    for key, value in headers.items():
        if key.lower() == name:
            return str(value)
    return ""


def iter_response(stream: Stream, response: Any, headers: dict[str, str]) -> Iterator[bytes]:
    """Перекачивает тело ответа блоками, переподключаясь при обрыве.

    Источник может закрыть соединение на середине — особенно когда человек
    бегает по ролику и открывает десяток диапазонов подряд. Браузер такой
    обрыв показывает как «поток не проигрывается», хотя достаточно попросить
    продолжение с того же байта.

    Оборванный ответ приходится узнавать по счётчику: при чтении блоками
    Python не отличает обрыв от честного конца файла — и там и там приходит
    пустой блок. Поэтому держим в уме, сколько байт нам обещали.
    """
    sent = _range_start(headers)
    length = _header(headers, "content-length")
    expected = sent + int(length) if length.isdigit() else 0
    attempts = 0

    def reopen() -> Any:
        """Просит у источника продолжение с того места, где оборвалось."""
        try:
            again, _, status = open_upstream(stream, f"bytes={sent}-")
        except OSError:
            return None
        return again if again is not None and status < 400 else None

    try:
        while True:
            try:
                chunk = response.read(CHUNK)
            except (OSError, EOFError, http.client.HTTPException):
                chunk = b""

            if chunk:
                sent += len(chunk)
                yield chunk
                continue

            # Пусто. Если обещали больше — это обрыв, а не конец.
            if not expected or sent >= expected:
                return
            attempts += 1
            if attempts > 3:
                return
            response.close()
            following = reopen()
            if following is None:
                return
            response = following
    finally:
        with contextlib.suppress(Exception):
            response.close()


# --- кадры и волна для окна разметки ---------------------------------------

#: Сколько кадров брать для ленты на таймлайне окна разметки.
STRIP_FRAMES = 24
STRIP_HEIGHT = 72

_strip_locks: dict[str, asyncio.Lock] = {}


def _work_dir() -> Path:
    from ..paths import data_dir

    folder = data_dir() / "stream-strips"
    folder.mkdir(parents=True, exist_ok=True)
    # Чужие ленты и волны живут, пока жив токен: дальше их никто не спросит.
    edge = time.time() - TOKEN_TTL
    for stale in folder.iterdir():
        with contextlib.suppress(OSError):
            if stale.stat().st_mtime < edge:
                stale.unlink()
    return folder


async def _ffmpeg(args: list[str]) -> bytes:
    process = await asyncio.create_subprocess_exec(
        binaries.ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error", *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=binaries.CREATE_NO_WINDOW,
        env=binaries.subprocess_env(),
    )
    out, err = await process.communicate()
    if process.returncode != 0:
        detail = err.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError(detail[-1] if detail else "ffmpeg не смог прочитать поток")
    return out


async def filmstrip(token: str, local: str) -> dict[str, Any]:
    """Лента кадров по ссылке — без скачивания ролика целиком.

    ffmpeg читает поток через наш же прокси (``local`` — его адрес): там
    подставлены заголовки и протухшая ссылка добывается заново. Каждый кадр
    — отдельный переход (``-ss`` до входа), то есть несколько небольших
    запросов с Range, а не весь файл.
    """
    stream = get(token)
    if not stream:
        raise ValueError("Ссылка на поток устарела — разберите её заново")
    duration = stream.duration or 0
    if duration <= 0:
        # У прямой ссылки на файл сайт длину не сообщает — спрашиваем сам
        # поток: ffprobe читает только заголовок.
        process = await asyncio.create_subprocess_exec(
            binaries.ffprobe(), "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", local,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            creationflags=binaries.CREATE_NO_WINDOW,
            env=binaries.subprocess_env(),
        )
        out, _ = await process.communicate()
        with contextlib.suppress(ValueError):
            duration = float(out.decode("utf-8", "replace").strip() or 0)
        stream.duration = duration or None
    if duration <= 0:
        raise ValueError("Длина ролика неизвестна — ленту кадров не построить")

    folder = _work_dir()
    sprite = folder / f"{token}.jpg"
    meta = folder / f"{token}.json"
    lock = _strip_locks.setdefault(token, asyncio.Lock())
    async with lock:
        if sprite.exists() and meta.exists():
            return json.loads(meta.read_text("utf-8"))

        frames = STRIP_FRAMES
        gate = asyncio.Semaphore(6)
        parts = [folder / f"{token}-{index:03d}.jpg" for index in range(frames)]

        async def grab(index: int) -> None:
            moment = duration * (index + 0.5) / frames
            async with gate:
                await _ffmpeg([
                    "-y", "-ss", f"{moment:.3f}", "-i", local,
                    "-frames:v", "1", "-an",
                    "-vf", f"scale=-2:{STRIP_HEIGHT}:flags=fast_bilinear",
                    "-q:v", "5", str(parts[index]),
                ])

        try:
            await asyncio.gather(*(grab(index) for index in range(frames)))
            await _ffmpeg([
                "-y", "-framerate", "1",
                "-i", str(folder / f"{token}-%03d.jpg"),
                "-vf", f"tile={frames}x1:padding=0:margin=0",
                "-frames:v", "1", "-q:v", "5", str(sprite),
            ])
        finally:
            for part in parts[1:]:
                part.unlink(missing_ok=True)

        # Ширину кадра узнаём по первому: форма у ролика одна.
        width = await asyncio.to_thread(_jpeg_width, parts[0])
        parts[0].unlink(missing_ok=True)
        result = {
            "url": f"/api/stream/{token}/strip.jpg",
            "frames": frames,
            "tileWidth": width or round(STRIP_HEIGHT * 16 / 9),
            "tileHeight": STRIP_HEIGHT,
        }
        meta.write_text(json.dumps(result), encoding="utf-8")
        return result


def _jpeg_width(path: Path) -> int:
    """Ширина JPEG по заголовку — без сторонних библиотек."""
    try:
        data = path.read_bytes()
    except OSError:
        return 0
    index = 2
    while index + 9 < len(data):
        if data[index] != 0xFF:
            index += 1
            continue
        marker = data[index + 1]
        length = int.from_bytes(data[index + 2:index + 4], "big")
        if marker in (0xC0, 0xC1, 0xC2):
            return int.from_bytes(data[index + 7:index + 9], "big")
        index += 2 + length
    return 0


def strip_file(token: str) -> Path | None:
    from ..paths import data_dir

    sprite = data_dir() / "stream-strips" / f"{token}.jpg"
    return sprite if sprite.exists() else None


async def waveform(token: str, local: str) -> dict[str, Any]:
    """Волна звука по ссылке — читается поток одного звука, если он есть."""
    from . import waveform as wave

    if not get(token):
        raise ValueError("Ссылка на поток устарела — разберите её заново")
    folder = _work_dir()
    stored = folder / f"{token}.wave.json"
    lock = _strip_locks.setdefault(f"wave-{token}", asyncio.Lock())
    async with lock:
        if stored.exists():
            return json.loads(stored.read_text("utf-8"))
        peaks = await wave._decode(local, 2000, wave.DEFAULT_BUCKETS)  # type: ignore[arg-type]
        result = {"peaks": peaks}
        stored.write_text(json.dumps(result), encoding="utf-8")
        return result
