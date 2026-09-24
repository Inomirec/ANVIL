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
import time
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


def target_for(source: str, smoothing: int, crop: bool) -> Path:
    """Где лежит (или будет лежать) ровная копия с этими настройками."""
    return _folder() / f"{_name(source, 'v1', smoothing, int(crop))}.mp4"


def _marks_for(source: str) -> Path:
    return _folder() / f"{_name(source, 'marks-v1')}.trf"


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


async def _make(source: str, smoothing: int, crop: bool) -> None:
    target = target_for(source, smoothing, crop)
    key = str(target)
    info = await probe(source)
    total = info.duration or 0.0
    marks = _marks_for(source)

    # Разметка тряски — одна на файл, какие бы настройки потом ни выбрали.
    lock = _locks.setdefault(source, asyncio.Lock())
    async with lock:
        if not marks.exists():
            partial = marks.with_suffix(".part.trf")
            partial.unlink(missing_ok=True)
            await _run(
                [
                    binaries.ffmpeg(), "-hide_banner", "-nostdin", "-y",
                    "-progress", "pipe:1", "-nostats", "-i", source,
                    "-vf", f"vidstabdetect=shakiness=6:accuracy=15:result={_escaped(partial)}",
                    "-an", "-f", "null", "-",
                ],
                total, 0.0, 0.5, key,
            )
            partial.replace(marks)
    _progress[key] = 0.5

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
            f"vidstabtransform=input={_escaped(marks)}:smoothing={smoothing}"
            f":optzoom={1 if crop else 0}:interpol=bicubic,unsharp=5:5:0.8:3:3:0.4",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p",
            # Звук тоже копируем: ролик без отдельной звуковой дорожки на
            # таймлайне берёт звук из того же файла, что и картинку.
            "-c:a", "aac", "-b:a", "320k",
            str(partial),
        ],
        total, 0.5, 0.5, key,
    )
    partial.replace(target)
    _progress[key] = 1.0


def _start(source: str, smoothing: int, crop: bool) -> asyncio.Task[None]:
    key = str(target_for(source, smoothing, crop))
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
            await _make(source, smoothing, crop)
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


def ready(source: str, smoothing: int, crop: bool) -> Path | None:
    """Готовая ровная копия или ``None``. Если её нет — начинает считать."""
    try:
        target = target_for(source, smoothing, crop)
    except OSError:
        return None
    if target.exists():
        return target
    if str(target) not in _errors:
        _start(source, smoothing, crop)
    return None


async def wait(source: str, smoothing: int, crop: bool) -> Path:
    """Ждёт ровную копию — для готового файла, который без неё собирать нельзя."""
    target = target_for(source, smoothing, crop)
    if target.exists():
        return target
    _errors.pop(str(target), None)
    await asyncio.shield(_start(source, smoothing, crop))
    if not target.exists():
        raise RuntimeError(
            "Не удалось стабилизировать ролик: " + _errors.get(str(target), "причина неизвестна")
        )
    return target


def status(source: str, smoothing: int, crop: bool) -> dict[str, object]:
    """Для карточки эффекта: готово, считается (и сколько) или ошибка."""
    try:
        target = target_for(source, smoothing, crop)
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
