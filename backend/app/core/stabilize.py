"""Стабилизатор: снять тряску с ролика.

ffmpeg стабилизирует в два прохода: `vidstabdetect` изучает, как трясётся
камера, и пишет разметку в файл, `vidstabtransform` по этой разметке
выравнивает кадры. Разметка привязана к **номеру кадра с начала файла** — а
монтаж читает ролик кусками с середины (кадр под иглой, куски просмотра), и
второй проход на таком куске взял бы чужие поправки.

Поэтому стабилизируется весь файл целиком, один раз, в фоне, и дальше монтаж
читает уже ровную копию вместо исходника — с теми же временами, так что
обрезка, разрез и «задом наперёд» работают как обычно. Разметка зависит только
от файла и считается однажды; ровная копия — на каждую пару настроек
(плавность, приближение). Всё лежит в кэше, `data_dir()/stabilized`.

Пока копии нет, кадр и просмотр показывают исходник, а карточка эффекта —
сколько осталось. Готовый файл ждёт копию: собрать его без стабилизации
значило бы молча выдать не то, что заказывали.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import math
import time
from dataclasses import dataclass
from pathlib import Path

from .. import paths
from . import binaries
from .probe import probe

#: Сколько держим ровные копии и разметку, если к ним не обращались.
_KEEP_SECONDS = 14 * 24 * 3600

#: Ровные копии, которые считаются сейчас: путь копии → задача.
_tasks: dict[str, asyncio.Task[None]] = {}
#: Сколько сделано, от 0 до 1: путь копии → доля.
_progress: dict[str, float] = {}
#: Последняя ошибка по копии — чтобы карточка сказала, а не ждала вечно.
_errors: dict[str, str] = {}
#: Какая копия считается для файла сейчас: исходник → путь копии. Сменили
#: настройку — прежний обсчёт отменяется, иначе каждое движение ползунка
#: запускало бы новый.
_current: dict[str, str] = {}
#: Один файл — один обсчёт разметки за раз.
_locks: dict[str, asyncio.Lock] = {}


def _folder() -> Path:
    folder = paths.data_dir() / "stabilized"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _stamp(source: str) -> str:
    """Отпечаток файла: путь, размер и время изменения."""
    target = Path(source)
    stat = target.stat()
    return f"{target.resolve()}|{stat.st_size}|{stat.st_mtime_ns}"


def _name(source: str, *parts: object) -> str:
    raw = "|".join([_stamp(source), *map(str, parts)])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]


def _number(params: dict[str, object], key: str, default: float, low: float, high: float) -> float:
    try:
        value = float(params.get(key, default))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        value = default
    return min(high, max(low, value))


#: Наклон на этой отметке и дальше — «без предела».
_ANGLE_FREE = 15.0


@dataclass(frozen=True)
class Settings:
    """Настройки стабилизатора — как их выставил человек, в его шкале.

    Две части: как искать тряску (``shakiness``, ``tripod`` — от них зависит
    разметка) и как выравнивать (всё остальное — от этого зависит копия).
    Сменили только вторую — разметку считать заново не нужно.
    """

    #: Насколько сильно трясёт: 1 — чуть, 10 — очень.
    shakiness: int = 8
    #: Сколько кадров сглаживать в каждую сторону.
    smoothing: int = 18
    #: Как на штативе: камера «замирает» на первом кадре.
    tripod: bool = False
    #: Приближение, чтобы спрятать края: нет, постоянное, плавно подстраивать.
    zoom: str = "static"
    #: Дополнительное приближение, в процентах.
    extra_zoom: int = 0
    #: Предел наклона в градусах; от ``_ANGLE_FREE`` и выше — без предела.
    max_angle: float = 3.0
    #: Открывшиеся края — кусками прошлых кадров, а не чёрным.
    keep_edges: bool = False

    @classmethod
    def from_params(cls, params: dict[str, object]) -> "Settings":
        zoom = str(params.get("zoom", ""))
        if zoom not in {"off", "static", "adaptive"}:
            # Проекты с прежней галочкой «Приблизить».
            zoom = "static" if _number(params, "crop", 1, 0, 1) >= 0.5 else "off"
        return cls(
            shakiness=int(_number(params, "shakiness", 8, 1, 10)),
            smoothing=int(_number(params, "smoothing", 18, 1, 100)),
            tripod=_number(params, "tripod", 0, 0, 1) >= 0.5,
            zoom=zoom,
            extra_zoom=int(_number(params, "extraZoom", 0, 0, 40)),
            max_angle=round(_number(params, "maxAngle", 3, 0, _ANGLE_FREE), 1),
            keep_edges=_number(params, "keepEdges", 0, 0, 1) >= 0.5,
        )

    def detect(self) -> str:
        """Фильтр поиска тряски, без пути к разметке."""
        # Поля помельче и допуск к малоконтрастным местам: тряска находится
        # увереннее, и копию меньше «водит». Проверено на ролике с тряской и
        # наклоном: рывки вдвое слабее, чем с обычными настройками фильтра.
        return (
            f"vidstabdetect=shakiness={self.shakiness}:accuracy=15:stepsize=4:mincontrast=0.2"
            + (":tripod=1" if self.tripod else "")
        )

    def transform(self) -> str:
        """Фильтр выравнивания, без пути к разметке."""
        optzoom = {"off": 0, "static": 1, "adaptive": 2}[self.zoom]
        # Ошибочно найденный наклон «водит» и гнёт картинку сильнее, чем
        # исходная тряска, поэтому по умолчанию он ограничен тремя градусами.
        angle = -1 if self.max_angle >= _ANGLE_FREE else math.radians(self.max_angle)
        parts = [
            f"smoothing={self.smoothing}",
            f"optzoom={optzoom}",
            "zoomspeed=0.2",
            f"zoom={self.extra_zoom}",
            f"maxangle={angle:.4f}",
            f"crop={'keep' if self.keep_edges else 'black'}",
            "interpol=bicubic",
        ]
        if self.tripod:
            parts.append("tripod=1")
        return ":".join(parts)


def target_for(source: str, settings: Settings) -> Path:
    """Где лежит (или будет лежать) ровная копия с этими настройками."""
    return _folder() / f"{_name(source, 'v3', settings)}.mp4"


def _marks_for(source: str, settings: Settings) -> Path:
    # Разметка зависит только от того, как искали тряску.
    return _folder() / f"{_name(source, 'marks-v3', settings.shakiness, settings.tripod)}.trf"


def _escaped(path: Path) -> str:
    """Путь внутри значения фильтра: двоеточие диска экранируем дважды."""
    backslash = chr(92)
    return str(path).replace(backslash, "/").replace(":", backslash * 2 + ":")


def _sweep() -> None:
    now = time.time()
    for item in _folder().iterdir():
        with contextlib.suppress(OSError):
            if now - item.stat().st_atime > _KEEP_SECONDS and str(item) not in _tasks:
                item.unlink()


async def _run(args: list[str], total: float, base: float, share: float, key: str) -> None:
    """Запускает ffmpeg и пишет долю готовности в ``_progress``."""
    process = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=binaries.CREATE_NO_WINDOW,
        env=binaries.subprocess_env(),
    )
    try:
        assert process.stdout is not None
        async for raw in process.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if line.startswith("out_time_us=") and total > 0:
                with contextlib.suppress(ValueError):
                    done = int(line.split("=", 1)[1]) / 1_000_000 / total
                    _progress[key] = base + share * max(0.0, min(1.0, done))
        _, err = await process.communicate()
        if process.returncode != 0:
            detail = err.decode("utf-8", "replace").strip().splitlines()
            raise RuntimeError(detail[0] if detail else "ffmpeg завершился с ошибкой")
    finally:
        # Отменили (сменили настройку, закрыли программу) — процесс не должен
        # остаться молотить в фоне.
        if process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            with contextlib.suppress(Exception):
                await process.wait()


async def _make(source: str, settings: Settings) -> None:
    target = target_for(source, settings)
    key = str(target)
    info = await probe(source)
    total = info.duration or 0.0
    marks = _marks_for(source, settings)

    # Разметка тряски — одна на файл, какие бы настройки потом ни выбрали.
    # Если она уже есть, считать осталось только копию — и её доля шкалы
    # вся от нуля до конца: прежде полоса в этом случае сразу вставала на
    # середину, как будто половина уже сделана.
    lock = _locks.setdefault(str(marks), asyncio.Lock())
    fresh = not marks.exists()
    async with lock:
        if not marks.exists():
            partial = marks.with_suffix(".part.trf")
            partial.unlink(missing_ok=True)
            await _run(
                [
                    binaries.ffmpeg(), "-hide_banner", "-nostdin", "-y",
                    "-progress", "pipe:1", "-nostats", "-i", source,
                    "-vf", f"{settings.detect()}:result={_escaped(partial)}",
                    "-an", "-f", "null", "-",
                ],
                total, 0.0, 0.5, key,
            )
            partial.replace(marks)
    base, share = (0.5, 0.5) if fresh else (0.0, 1.0)
    _progress[key] = base

    # Ровная копия: почти без потерь, чтобы вторая сборка не мылила картинку.
    # Лёгкая резкость после выравнивания — как советуют сами авторы фильтра:
    # поворот и сдвиг кадра чуть смягчают его.
    partial = target.with_suffix(".part.mp4")
    partial.unlink(missing_ok=True)
    await _run(
        [
            binaries.ffmpeg(), "-hide_banner", "-nostdin", "-y",
            "-progress", "pipe:1", "-nostats", "-i", source,
            "-vf",
            f"vidstabtransform=input={_escaped(marks)}:{settings.transform()}"
            ",unsharp=5:5:0.8:3:3:0.4",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p",
            # Звук тоже копируем: ролик без отдельной звуковой дорожки на
            # таймлайне берёт звук из того же файла, что и картинку.
            "-c:a", "aac", "-b:a", "320k",
            str(partial),
        ],
        total, base, share, key,
    )
    partial.replace(target)
    _progress[key] = 1.0


def _start(source: str, settings: Settings) -> asyncio.Task[None]:
    key = str(target_for(source, settings))
    running = _tasks.get(key)
    if running and not running.done():
        return running
    # Для этого файла уже считается другая настройка — она больше не нужна.
    previous = _current.get(source)
    if previous and previous != key and previous in _tasks:
        _tasks[previous].cancel()
    _current[source] = key
    _errors.pop(key, None)
    _progress[key] = 0.0

    async def job() -> None:
        try:
            await _make(source, settings)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — причину покажем в карточке
            _errors[key] = str(exc)
        finally:
            _tasks.pop(key, None)

    with contextlib.suppress(OSError):
        _sweep()
    task = asyncio.get_running_loop().create_task(job())
    _tasks[key] = task
    return task


def ready(source: str, settings: Settings) -> Path | None:
    """Готовая ровная копия или ``None``. Если её нет — начинает считать."""
    try:
        target = target_for(source, settings)
    except OSError:
        return None
    if target.exists():
        return target
    if str(target) not in _errors:
        _start(source, settings)
    return None


async def wait(source: str, settings: Settings) -> Path:
    """Ждёт ровную копию — для готового файла, который без неё собирать нельзя."""
    target = target_for(source, settings)
    if target.exists():
        return target
    _errors.pop(str(target), None)
    await asyncio.shield(_start(source, settings))
    if not target.exists():
        raise RuntimeError(
            "Не удалось стабилизировать ролик: " + _errors.get(str(target), "причина неизвестна")
        )
    return target


def status(source: str, settings: Settings) -> dict[str, object]:
    """Для карточки эффекта: готово, считается (и сколько) или ошибка."""
    try:
        target = target_for(source, settings)
    except OSError:
        return {"state": "missing"}
    key = str(target)
    if target.exists():
        return {"state": "ready"}
    if key in _errors:
        return {"state": "error", "error": _errors[key]}
    if key in _tasks:
        return {"state": "working", "progress": round(_progress.get(key, 0.0), 3)}
    return {"state": "idle"}
