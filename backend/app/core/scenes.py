"""Смены сцен в ролике и кадры для ленты на таймлайне.

Равномерная лента кадров (``filmstrip``) не знает, где в ролике склейки:
плитка показывает случайный кадр своего отрезка, и по ленте не понять, где
кончается одна сцена и начинается другая. Здесь ролик читается один раз в
малом размере, и ffmpeg сам отмечает кадры, сильно непохожие на предыдущий
(``scene``), — это и есть склейки. Заодно берётся кадр каждые несколько
секунд, чтобы длинной сцене было что показать внутри.

Кадры складываются в одну картинку-сетку (как у ленты кадров), рядом лежит
список: время каждого кадра и склейка ли это.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from ..paths import data_dir
from . import binaries
from .probe import probe

#: Высота кадра в сетке; ширина — по форме ролика.
TILE_HEIGHT = 72
#: Крупные кадры — для растянутой дорожки. Их меньше: сетка иначе вышла бы
#: огромной картинкой.
LARGE_HEIGHT = 160
LARGE_FRAMES = 400

#: Кадров в ряду сетки. Картинка не должна выходить за пределы JPEG.
COLUMNS = 32

#: Больше кадров не берём: сетка стала бы слишком тяжёлой.
MAX_FRAMES = 1500

#: Насколько кадр должен отличаться от предыдущего, чтобы считаться склейкой.
THRESHOLD = 0.3

#: Склейки ближе этого друг к другу — вспышки, а не сцены.
MIN_SCENE = 0.2

#: Метка версии в имени кэша: сменили способ поиска — старые ответы не берём.
VERSION = "v1"

#: Поиск читает ролик целиком — несколько сразу загрузили бы машину.
_gate = asyncio.Semaphore(2)
_locks: dict[str, asyncio.Lock] = {}

_SHOWINFO = re.compile(r"pts_time:\s*([0-9.eE+-]+)")
_SCORE = re.compile(r"lavfi\.scene_score=([0-9.eE+-]+)")


@dataclass(slots=True)
class Scenes:
    sprite: Path
    tile_width: int
    tile_height: int
    columns: int
    fps: float
    #: Время каждого кадра сетки, по порядку.
    times: list[float] = field(default_factory=list)
    #: Номера кадров сетки, с которых начинается новая сцена.
    cuts: list[int] = field(default_factory=list)

    def as_json(self) -> dict:
        return {
            "tileWidth": self.tile_width,
            "tileHeight": self.tile_height,
            "columns": self.columns,
            "fps": self.fps,
            "times": self.times,
            "cuts": self.cuts,
        }


def cache_dir() -> Path:
    return data_dir() / "scenes"


def _key(source: Path, height: int = TILE_HEIGHT) -> str:
    try:
        stat = source.stat()
        signature = f"{source}|{stat.st_mtime_ns}|{stat.st_size}|{VERSION}|{height}"
    except OSError:
        signature = f"{source}|{VERSION}|{height}"
    return hashlib.sha1(signature.encode("utf-8")).hexdigest()


def _load(sprite: Path) -> Scenes | None:
    meta = sprite.with_suffix(".json")
    if not sprite.exists() or not meta.exists():
        return None
    try:
        data = json.loads(meta.read_text("utf-8"))
        return Scenes(
            sprite,
            int(data["tileWidth"]),
            int(data["tileHeight"]),
            int(data["columns"]),
            float(data["fps"]),
            [float(value) for value in data["times"]],
            [int(value) for value in data["cuts"]],
        )
    except (OSError, ValueError, KeyError, TypeError):
        return None


def cached(source: Path, height: int = TILE_HEIGHT) -> Scenes | None:
    """Готовый ответ, если он уже есть, — без чтения ролика."""
    return _load(cache_dir() / f"{_key(source, height)}.jpg")


async def _run(args: list[str]) -> tuple[int, str]:
    process = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        creationflags=binaries.CREATE_NO_WINDOW,
        env=binaries.subprocess_env(),
    )
    _, err = await process.communicate()
    return process.returncode or 0, err.decode("utf-8", "replace")


async def build(source: Path, large: bool = False) -> Scenes | None:
    """Находит склейки и собирает сетку кадров (или берёт из кэша).

    ``large`` — кадры покрупнее, для растянутой дорожки.
    """
    tile_height = LARGE_HEIGHT if large else TILE_HEIGHT
    limit = LARGE_FRAMES if large else MAX_FRAMES
    sprite = cache_dir() / f"{_key(source, tile_height)}.jpg"
    ready = _load(sprite)
    if ready:
        return ready

    lock = _locks.setdefault(str(sprite), asyncio.Lock())
    async with lock:
        ready = _load(sprite)
        if ready:
            return ready

        info = await probe(source)
        video = info.video
        if not video or not video.width or not video.height or not info.duration:
            return None
        duration = info.duration
        fps = video.fps or 25.0

        tile_width = max(2, int(round(tile_height * video.width / video.height / 2)) * 2)
        # Кадр внутри сцены — каждые несколько секунд, реже для длинных роликов.
        step = min(10.0, max(0.5, duration / (100 if large else 200)))

        work = cache_dir() / f"{sprite.stem}-frames"
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True, exist_ok=True)
        try:
            chain = (
                f"scale={tile_width}:{tile_height}:flags=fast_bilinear,"
                f"select='eq(n\\,0)+gt(scene\\,{THRESHOLD})+gte(t-prev_selected_t\\,{step:.3f})',"
                "metadata=print:key=lavfi.scene_score,showinfo"
            )
            async with _gate:
                code, log = await _run([
                    binaries.ffmpeg(),
                    "-hide_banner", "-nostdin", "-loglevel", "info", "-y",
                    "-i", str(source),
                    "-an", "-sn", "-dn",
                    "-vf", chain,
                    "-fps_mode", "passthrough",
                    "-frames:v", str(limit),
                    "-q:v", "4",
                    str(work / "f%05d.jpg"),
                ])
            if code != 0:
                raise RuntimeError(log.strip().splitlines()[-1] if log.strip() else "ffmpeg не смог прочитать ролик")

            # На каждый выбранный кадр ffmpeg пишет строку с оценкой, затем
            # строку с временем — идут парами и по порядку.
            times: list[float] = []
            scores: list[float] = []
            pending = 0.0
            for line in log.splitlines():
                score = _SCORE.search(line)
                if score:
                    pending = float(score.group(1))
                    continue
                if "Parsed_showinfo" in line and " n:" in line:
                    moment = _SHOWINFO.search(line)
                    if moment:
                        times.append(float(moment.group(1)))
                        scores.append(pending)
                        pending = 0.0

            count = len(list(work.glob("f*.jpg")))
            times = times[:count]
            if not times:
                return None

            cuts: list[int] = []
            last_cut = times[0]
            for index, (moment, score) in enumerate(zip(times, scores)):
                if index and score > THRESHOLD and moment - last_cut >= MIN_SCENE:
                    cuts.append(index)
                    last_cut = moment

            wide = COLUMNS // 2 if large else COLUMNS
            rows = (len(times) + wide - 1) // wide
            columns = min(wide, len(times))
            code, log = await _run([
                binaries.ffmpeg(),
                "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
                "-framerate", "1",
                "-i", str(work / "f%05d.jpg"),
                "-vf", f"tile={columns}x{rows}:padding=0:margin=0",
                "-frames:v", "1",
                "-q:v", "4",
                str(sprite),
            ])
            if code != 0 or not sprite.exists():
                raise RuntimeError(log.strip()[:200] or "ffmpeg не смог собрать кадры")

            result = Scenes(sprite, tile_width, tile_height, columns, fps, times, cuts)
            sprite.with_suffix(".json").write_text(json.dumps(result.as_json()), encoding="utf-8")
            return result
        finally:
            shutil.rmtree(work, ignore_errors=True)


def clear_cache() -> int:
    removed = 0
    for file in list(cache_dir().glob("*.jpg")) + list(cache_dir().glob("*.json")):
        try:
            file.unlink()
            removed += 1
        except OSError:
            continue
    return removed
