"""Формы появления и ухода: как быстро картинка и звук набирают силу.

Пять форм, как в монтажных программах: линейная, быстрая, медленная,
плавная и резкая. Форма задаётся для появления; уход — её зеркало: «быстрый»
уход быстро гаснет в начале, как «быстрое» появление быстро набирает силу.
Одна и та же форма — у звука (готовые кривые `afade`), у прозрачности в
монтаже (значение на каждый кадр) и у ухода в чёрный при обработке файла
(формула в `geq`). Те же формулы — у окна (`fadeShape` в `lib/fades.ts`).

Пустая форма — как было до выбора форм: картинка линейно, звук по
четверти синуса.
"""

from __future__ import annotations

import math

CURVES = ("linear", "fast", "slow", "smooth", "sharp")

#: Кривые `afade` для появления и ухода. Сверено замером: уход у `afade` —
#: зеркало появления во времени, поэтому быстрому уходу нужна «медленная»
#: кривая, и наоборот.
_AFADE = {
    "linear": ("tri", "tri"),
    "fast": ("ipar", "qua"),
    "slow": ("qua", "ipar"),
    "smooth": ("hsin", "hsin"),
    "sharp": ("ihsin", "ihsin"),
}


def shape(curve: str, share: float) -> float:
    """Сила появления на доле ``share`` его длины (0…1)."""
    s = max(0.0, min(1.0, share))
    if curve == "fast":
        return 1 - (1 - s) ** 2
    if curve == "slow":
        return s * s
    if curve == "smooth":
        return (1 - math.cos(math.pi * s)) / 2
    if curve == "sharp":
        return math.acos(1 - 2 * s) / math.pi
    return s


def gain_in(curve: str, share: float) -> float:
    """Видимость при появлении, ``share`` — пройденная доля."""
    return shape(curve, share)


def gain_out(curve: str, left: float) -> float:
    """Видимость при уходе, ``left`` — оставшаяся доля (1 в начале ухода)."""
    return 1 - shape(curve, 1 - left)


def afade_curve(curve: str, side: str) -> str:
    """Кривая `afade` для звука; пустая форма — четверть синуса, как раньше."""
    pair = _AFADE.get(curve)
    if not pair:
        return "qsin"
    return pair[0] if side == "in" else pair[1]


def custom(curve: str) -> bool:
    """Форма отличается от обычной линейной — `fade` её не нарисует."""
    return curve in CURVES and curve != "linear"


def expression(curve: str, share: str) -> str:
    """Та же форма формулой ffmpeg от доли ``share``."""
    s = f"clip({share},0,1)"
    if curve == "fast":
        return f"(1-pow(1-{s},2))"
    if curve == "slow":
        return f"pow({s},2)"
    if curve == "smooth":
        return f"((1-cos(PI*{s}))/2)"
    if curve == "sharp":
        return f"(acos(1-2*{s})/PI)"
    return s
