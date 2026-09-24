"""Ключи анимации: у каждого показателя клипа — свой список ключей.

Показатель — это одно число клипа: место (``x``, ``y``), размер (``size``,
``sizeY``), обрезка (``cropLeft``…), маска (``mask.x``…), настройка эффекта
(``fx.<номер эффекта>.<настройка>``). Имена те же, что в окне программы
(``composeAnim.ts``), поэтому ключи доезжают до сервера без перевода.

Ключ — время от начала клипа на таймлайне и значение. До первого ключа
показатель стоит как в первом, после последнего — как в последнем, между
ними плавно переходит с разгоном и торможением (``3s² − 2s³``). Та же кривая
в окне программы, иначе рамка в кадре и собранный кадр расходились бы.

Время ключа бывает меньше нуля и больше длины клипа: после обрезки и разреза
ключи остаются на тех же кадрах ролика.
"""

from __future__ import annotations

import math
from typing import Callable

from ..models import AnimKey, ComposeClip

#: Какое поле модели стоит за показателем.
_PLAIN = {
    "x": "x",
    "y": "y",
    "size": "size",
    "sizeY": "size_y",
    "cropLeft": "crop_left",
    "cropTop": "crop_top",
    "cropRight": "crop_right",
    "cropBottom": "crop_bottom",
}


def keys(clip: ComposeClip, field: str) -> list[AnimKey]:
    return sorted(clip.anim.get(field, []), key=lambda key: key.t)


def animated(clip: ComposeClip, *fields: str) -> bool:
    """Есть ли ключи хоть у одного из показателей."""
    return any(clip.anim.get(field) for field in fields)


def animated_prefix(clip: ComposeClip, prefix: str) -> bool:
    return any(values for field, values in clip.anim.items() if field.startswith(prefix))


def static(clip: ComposeClip, field: str) -> float:
    """Значение показателя без ключей — то, что записано в самом клипе."""
    if field in _PLAIN:
        return float(getattr(clip, _PLAIN[field]))
    if field.startswith("mask.") and clip.mask is not None:
        return float(getattr(clip.mask, field[5:], 0.0))
    if field.startswith("fx."):
        _, effect_id, param = field.split(".", 2)
        for effect in clip.effects:
            if effect.id == effect_id:
                try:
                    return float(effect.params.get(param, 0.0))
                except (TypeError, ValueError):
                    return 0.0
    return 0.0


def _ease(progress: float) -> float:
    return progress * progress * (3 - 2 * progress)


def _raw_at(clip: ComposeClip, field: str, local: float) -> float:
    found = keys(clip, field)
    if not found:
        return static(clip, field)
    if local <= found[0].t:
        return found[0].v
    for left, right in zip(found, found[1:]):
        if local < right.t:
            span = max(right.t - left.t, 1e-3)
            return left.v + (right.v - left.v) * _ease((local - left.t) / span)
    return found[-1].v


def value_at(clip: ComposeClip, field: str, local: float) -> float:
    """Значение показателя через ``local`` секунд от начала клипа."""
    value = _raw_at(clip, field, local)
    # Высота «как ширина» — ноль; тогда берём размер в тот же миг.
    if field == "sizeY" and value <= 0:
        return _raw_at(clip, "size", local)
    return value


def expression(clip: ComposeClip, field: str, moment: str, scale: Callable[[float], float] | None = None) -> str:
    """Выражение ffmpeg для показателя в момент ``moment`` (секунды клипа).

    ``scale`` переводит значение в шкалу фильтра (например, проценты в
    доли); сама кривая при этом та же, если перевод линейный.
    """
    convert = scale or (lambda value: value)
    found = keys(clip, field)
    if field == "sizeY":
        if not found:
            if static(clip, "sizeY") > 0:
                return f"{convert(static(clip, 'sizeY')):.5f}"
            return expression(clip, "size", moment, scale)
        # Ключ «как ширина» берёт размер в тот же миг.
        values = [key.v if key.v > 0 else _raw_at(clip, "size", key.t) for key in found]
    else:
        if not found:
            return f"{convert(static(clip, field)):.5f}"
        values = [key.v for key in found]

    points = [(key.t, convert(value)) for key, value in zip(found, values)]
    result = f"{points[-1][1]:.5f}"
    for (lt, lv), (rt, rv) in reversed(list(zip(points, points[1:]))):
        span = max(rt - lt, 1e-3)
        progress = f"(({moment})-({lt:.4f}))/{span:.4f}"
        segment = f"{lv:.5f}+({rv - lv:.5f})*({progress})*({progress})*(3-2*({progress}))"
        # Время ключа — в скобках: оно бывает и меньше нуля.
        result = f"if(lt({moment},({rt:.4f})),{segment},{result})"
    return f"if(lt({moment},({points[0][0]:.4f})),{points[0][1]:.5f},{result})"


def commands(
    clip: ComposeClip,
    field: str,
    target: str,
    option: str,
    *,
    skip: float,
    take: float,
    fps: int,
    scale: Callable[[float], float] | None = None,
    digits: int = 3,
) -> list[tuple[float, str]]:
    """Команды для ``sendcmd``: значение показателя на каждом кадре куска.

    Нужны фильтрам, у которых настройку можно менять на ходу командой, но
    нельзя задать формулой от времени (размытие, пикселизация, температура).
    Время — от начала читаемого куска; повторы одного и того же значения
    пропускаем, чтобы файл не рос зря.
    """
    convert = scale or (lambda value: value)
    found: list[tuple[float, str]] = []
    last: str | None = None
    rate = max(fps, 1)
    for index in range(max(1, int(math.ceil(take * rate)) + 1)):
        moment = index / rate
        value = f"{convert(value_at(clip, field, moment + skip)):.{digits}f}"
        if value != last:
            found.append((moment, f"{target} {option} {value}"))
            last = value
    return found


def _store(clip: ComposeClip, field: str, value: float) -> None:
    """Записать значение показателя в сам клип."""
    if field in _PLAIN:
        setattr(clip, _PLAIN[field], value)
    elif field.startswith("mask.") and clip.mask is not None:
        setattr(clip.mask, field[5:], value)
    elif field.startswith("fx."):
        _, effect_id, param = field.split(".", 2)
        for effect in clip.effects:
            if effect.id == effect_id:
                effect.params[param] = value


def settle(clip: ComposeClip) -> None:
    """Ключи, которые ничего не меняют, — в обычные значения клипа.

    Один ключ (или несколько с одним значением) — это просто значение: так
    обрезка с единственным ключом собирается обычным быстрым способом, а не
    маской на каждом кадре. У маски с ключами в клип записывается самый
    крупный размер: по нему рисуется картинка формы, и уменьшать её не
    страшно, а растягивать мелкую — мыльно.
    """
    for field in list(clip.anim):
        found = clip.anim[field]
        if not found:
            del clip.anim[field]
            continue
        values = {round(key.v, 6) for key in found}
        if len(values) == 1:
            try:
                _store(clip, field, found[0].v)
            except ValueError:
                pass
            del clip.anim[field]
        elif field in {"mask.w", "mask.h"}:
            _store(clip, field, max(key.v for key in found))
