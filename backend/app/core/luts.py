"""LUT — готовый цветокор одним фильтром (`lut3d`).

LUT — таблица «какой цвет каким сделать», файл `.cube`. Своих у человека
обычно нет, поэтому несколько простых образов программа считает сама. Силу
эффекта ffmpeg у `lut3d` не задаёт, поэтому она «запекается» в саму таблицу:
каждый цвет сдвигается к цвету образа на долю силы. Готовые таблицы лежат в
`data_dir()/luts` и считаются один раз на образ, файл и силу.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
import time
from pathlib import Path
from typing import Callable

from ..paths import data_dir

#: Точек на сторону куба у своих образов. 33 — обычный размер: переходы
#: гладкие, файл около мегабайта.
SIZE = 33

#: Сколько держать посчитанные таблицы, которыми никто не пользуется.
_KEEP = 7 * 24 * 3600

Colour = tuple[float, float, float]


def _clamp(value: float) -> float:
    return 0.0 if value < 0 else 1.0 if value > 1 else value


def _luma(r: float, g: float, b: float) -> float:
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _saturate(colour: Colour, amount: float) -> Colour:
    grey = _luma(*colour)
    return tuple(grey + (channel - grey) * amount for channel in colour)  # type: ignore[return-value]


def _contrast(value: float, amount: float) -> float:
    # Мягкая S-кривая вокруг середины: тени глубже, света ярче.
    return 0.5 + (value - 0.5) * amount


def _warm(r: float, g: float, b: float) -> Colour:
    return r * 1.06 + 0.015, g * 1.01, b * 0.88


def _cold(r: float, g: float, b: float) -> Colour:
    return r * 0.9, g * 1.0, b * 1.08 + 0.02


def _cinema(r: float, g: float, b: float) -> Colour:
    # Тени уходят в бирюзу, света — в тёплый оранжевый: привычный «киношный» вид.
    light = _luma(r, g, b) - 0.5
    r, g, b = r + 0.09 * light, g + 0.01 * light, b - 0.09 * light
    return tuple(_contrast(channel, 1.08) for channel in (r, g, b))  # type: ignore[return-value]


def _faded(r: float, g: float, b: float) -> Colour:
    # Приподнятые тени и опущенные света, цвет чуть приглушён — «плёнка».
    r, g, b = _saturate((r, g, b), 0.8)
    return tuple(0.07 + channel * 0.86 for channel in (r, g, b))  # type: ignore[return-value]


def _vivid(r: float, g: float, b: float) -> Colour:
    r, g, b = _saturate((r, g, b), 1.3)
    return tuple(_contrast(channel, 1.06) for channel in (r, g, b))  # type: ignore[return-value]


def _noir(r: float, g: float, b: float) -> Colour:
    grey = _contrast(_luma(r, g, b), 1.25)
    return grey, grey, grey


#: Готовые образы — те же имена, что в окне (`composeEffects.ts`).
LOOKS: dict[str, Callable[[float, float, float], Colour]] = {
    "warm": _warm,
    "cold": _cold,
    "cinema": _cinema,
    "faded": _faded,
    "vivid": _vivid,
    "noir": _noir,
}


def _write(target: Path, size: int, colours: list[Colour]) -> None:
    lines = [f"LUT_3D_SIZE {size}"]
    lines += [f"{r:.5f} {g:.5f} {b:.5f}" for r, g, b in colours]
    target.write_text("\n".join(lines) + "\n", encoding="ascii")


def _read(source: Path) -> tuple[int, list[Colour], tuple[float, float]]:
    """Таблица из файла `.cube`: размер, цвета (красный меняется быстрее всех)."""
    size = 0
    low, high = 0.0, 1.0
    colours: list[Colour] = []
    for raw in source.read_text("utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        head = line.split()[0].upper()
        if head == "LUT_3D_SIZE":
            size = int(line.split()[1])
        elif head == "DOMAIN_MIN":
            low = float(line.split()[1])
        elif head == "DOMAIN_MAX":
            high = float(line.split()[1])
        elif head in {"TITLE", "LUT_1D_SIZE", "LUT_1D_INPUT_RANGE", "LUT_3D_INPUT_RANGE"}:
            if head == "LUT_1D_SIZE":
                raise ValueError("Это одномерный LUT — нужен трёхмерный (LUT_3D_SIZE)")
            continue
        else:
            parts = line.split()
            if len(parts) >= 3:
                colours.append((float(parts[0]), float(parts[1]), float(parts[2])))
    if not size or len(colours) != size ** 3:
        raise ValueError("Файл не похож на LUT в формате .cube")
    return size, colours, (low, high)


def _grid(size: int) -> list[Colour]:
    """Исходные цвета узлов куба — в том же порядке, что и в файле."""
    step = size - 1
    return [
        (r / step, g / step, b / step)
        for b in range(size)
        for g in range(size)
        for r in range(size)
    ]


def _sweep(folder: Path, keep: Path) -> None:
    edge = time.time() - _KEEP
    for stale in folder.glob("*.cube"):
        if stale == keep:
            continue
        with contextlib.suppress(OSError):
            if stale.stat().st_mtime < edge:
                stale.unlink()


def prepared(look: str, file: str, strength: float) -> Path | None:
    """Таблица для `lut3d` с силой эффекта внутри. ``None`` — применять нечего.

    ``look`` — готовый образ или ``file`` (тогда берётся ``file``). Сила —
    от 0 до 1: на нуле эффекта нет, на единице — образ целиком.
    """
    strength = max(0.0, min(1.0, strength))
    if strength <= 0.001:
        return None
    source: Path | None = None
    if look == "file":
        if not file:
            return None
        source = Path(file)
        if not source.is_file():
            return None
        stamp = f"file|{source}|{source.stat().st_mtime_ns}|{strength:.3f}"
    elif look in LOOKS:
        stamp = f"look|{look}|{SIZE}|{strength:.3f}|v1"
    else:
        return None

    folder = data_dir() / "luts"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{hashlib.sha1(stamp.encode('utf-8')).hexdigest()[:20]}.cube"
    if target.exists():
        # Снова нужна — свежая: иначе чистка по возрасту стёрла бы её.
        with contextlib.suppress(OSError):
            os.utime(target)
        return target

    if source is not None:
        size, colours, (low, high) = _read(source)
        span = (high - low) or 1.0
        colours = [tuple((channel - low) / span for channel in colour) for colour in colours]  # type: ignore[misc]
    else:
        size = SIZE
        shape = LOOKS[look]
        colours = [shape(*colour) for colour in _grid(size)]
    mixed = [
        tuple(_clamp(base + (new - base) * strength) for base, new in zip(start, end))
        for start, end in zip(_grid(size), colours)
    ]
    _write(target, size, mixed)  # type: ignore[arg-type]
    _sweep(folder, target)
    return target
