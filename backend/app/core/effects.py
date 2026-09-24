"""Эффекты клипа в монтаже: что человек выбрал — в фильтры ffmpeg.

Эффекты встают в цепочку клипа **до** того, как он вписывается в кадр: так
они работают с самим файлом, а не с кадром проекта, и кадр под иглой,
просмотр и рендер получают их одинаково — всё это собирает одна функция.

Каждый эффект — словарь настроек с числами в понятной человеку шкале
(«теплее на 30», «размытие 12»). Здесь же они переводятся в числа ffmpeg и
зажимаются в допустимые пределы: файл проекта могли поправить руками, а
ffmpeg на число вне шкалы отвечает отказом собирать.

Отражение, поворот и «задом наперёд» — не эффекты из списка, а свойства
клипа: их включают из меню по правой кнопке одним нажатием.
"""

from __future__ import annotations

import re

from ..models import ClipEffect, ComposeClip

#: Цвет для хромакея — только «#rrggbb», иначе в команду попало бы что угодно.
_HEX = re.compile(r"#?[0-9a-fA-F]{6}")


def _number(effect: ClipEffect, key: str, default: float, low: float, high: float) -> float:
    try:
        value = float(effect.params.get(key, default))
    except (TypeError, ValueError):
        value = default
    return min(high, max(low, value))


def _colour(effect: ClipEffect, key: str, default: str) -> str:
    value = str(effect.params.get(key, default))
    if not _HEX.fullmatch(value):
        value = default
    return "0x" + value.lstrip("#")


def _video_effect(effect: ClipEffect) -> str:
    kind = effect.type
    if kind == "color":
        # Шкалы -100…100, ноль — как было.
        bright = _number(effect, "brightness", 0, -100, 100) / 100 * 0.3
        contrast = 1 + _number(effect, "contrast", 0, -100, 100) / 100 * 0.8
        saturation = 1 + _number(effect, "saturation", 0, -100, 100) / 100
        warm = _number(effect, "temperature", 0, -100, 100)
        parts = [f"eq=brightness={bright:.3f}:contrast={contrast:.3f}:saturation={saturation:.3f}"]
        if abs(warm) > 0.5:
            # Теплее — ниже температура, холоднее — выше. 6500 K — нейтральный
            # белый, вдвое ниже — заметно жёлто, вдвое выше — заметно синё.
            kelvin = 6500 * 2 ** (-warm / 100)
            parts.append(f"colortemperature=temperature={kelvin:.0f}")
        return ",".join(parts)
    if kind == "mono":
        strength = _number(effect, "strength", 100, 0, 100) / 100
        return f"hue=s={1 - strength:.3f}"
    if kind == "blur":
        sigma = _number(effect, "strength", 10, 0.5, 80)
        return f"gblur=sigma={sigma:.2f}"
    if kind == "denoise":
        # Соотношение между четырьмя числами — как у обычных настроек фильтра,
        # ползунок двигает их вместе.
        s = _number(effect, "strength", 4, 1, 12)
        return f"hqdn3d={s:.2f}:{s * 0.75:.2f}:{s * 1.5:.2f}:{s * 1.125:.2f}"
    if kind == "pixelate":
        size = int(_number(effect, "size", 16, 2, 120))
        return f"pixelize=w={size}:h={size}"
    if kind == "chromakey":
        colour = _colour(effect, "color", "#00ff00")
        similar = _number(effect, "similarity", 15, 1, 60) / 100
        blend = _number(effect, "blend", 5, 0, 40) / 100
        # Прозрачность нужна до вырезания, иначе вырезанное станет чёрным.
        return f"format=yuva420p,chromakey=color={colour}:similarity={similar:.3f}:blend={blend:.3f}"
    return ""


def _audio_effect(effect: ClipEffect) -> str:
    kind = effect.type
    if kind == "voice_denoise":
        # Насколько приглушать шум, в децибелах.
        amount = _number(effect, "strength", 12, 1, 40)
        return f"afftdn=nr={amount:.1f}:nf=-30"
    if kind == "leveler":
        # Насколько можно подтянуть тихое место. Больше — ровнее, но и шум
        # в паузах подтягивается вместе с голосом.
        gain = _number(effect, "strength", 10, 1, 30)
        return f"dynaudnorm=f=250:g=15:p=0.95:m={gain:.1f}"
    if kind == "echo":
        delay = _number(effect, "delay", 300, 20, 1500)
        decay = _number(effect, "decay", 40, 5, 90) / 100
        return f"aecho=0.8:0.9:{delay:.0f}:{decay:.2f}"
    return ""


def video_chain(clip: ComposeClip) -> str:
    """Фильтры картинки клипа — с запятой в конце или пустая строка.

    Сначала «задом наперёд», поворот и отражение: эффекты должны видеть кадр
    уже в том виде, в каком его покажут, — иначе пикселизация или хромакей
    считались бы по лежащему на боку кадру.
    """
    parts: list[str] = []
    if clip.reverse and clip.kind == "video":
        parts.append("reverse")
    turn = clip.rotate % 360
    if turn == 90:
        parts.append("transpose=clock")
    elif turn == 180:
        parts.append("hflip,vflip")
    elif turn == 270:
        parts.append("transpose=cclock")
    if clip.flip_h:
        parts.append("hflip")
    if clip.flip_v:
        parts.append("vflip")
    for effect in clip.effects:
        if effect.on:
            chunk = _video_effect(effect)
            if chunk:
                parts.append(chunk)
    return ",".join(parts) + "," if parts else ""


def audio_chain(clip: ComposeClip) -> str:
    """Фильтры звука клипа — с запятой в конце или пустая строка."""
    parts: list[str] = []
    if clip.reverse:
        parts.append("areverse")
    for effect in clip.effects:
        if effect.on:
            chunk = _audio_effect(effect)
            if chunk:
                parts.append(chunk)
    return ",".join(parts) + "," if parts else ""
