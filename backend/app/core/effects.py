"""Эффекты клипа в монтаже: что человек выбрал — в фильтры ffmpeg.

Эффекты встают в цепочку клипа **до** того, как он вписывается в кадр: так
они работают с самим файлом, а не с кадром проекта, и кадр под иглой,
просмотр и рендер получают их одинаково — всё это собирает одна функция.

Каждый эффект — словарь настроек с числами в понятной человеку шкале
(«теплее на 30», «размытие 12»). Здесь же они переводятся в числа ffmpeg и
зажимаются в допустимые пределы: файл проекта могли поправить руками, а
ffmpeg на число вне шкалы отвечает отказом собирать.

Часть настроек меняется по ключам (``ANIMATABLE``). Такие настройки фильтр
получает формулой от времени, если он её понимает (``eq``, ``hue``), или
командами на каждый кадр (``sendcmd``) — размытие, пикселизация, температура.

Отражение, поворот и «задом наперёд» — не эффекты из списка, а свойства
клипа: их включают из меню по правой кнопке одним нажатием.
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass
from typing import Callable

from .. import paths
from ..models import ClipEffect, ComposeClip
from . import anim, stabilize

BACKSLASH = chr(92)

#: Цвет для хромакея — только «#rrggbb», иначе в команду попало бы что угодно.
_HEX = re.compile(r"#?[0-9a-fA-F]{6}")

#: Какие настройки эффектов умеют меняться по ключам. Те же в окне
#: программы (``animatable`` в ``composeEffects.ts``).
ANIMATABLE = {
    "color": {"brightness", "contrast", "saturation", "temperature"},
    "mono": {"strength"},
    "blur": {"strength"},
    "pixelate": {"size"},
}

CROP_FIELDS = ("cropLeft", "cropTop", "cropRight", "cropBottom")


@dataclass(slots=True)
class Timing:
    """Где в клипе читаемый кусок: для показателей, меняющихся по ключам.

    ``skip`` — сколько клипа прошло к началу куска (время внутри цепочки
    клипа идёт от нуля), ``take`` — длина куска, ``tag`` — метка клипа в
    графе: из неё собираются имена фильтров, которым шлются команды.
    """

    skip: float
    take: float
    fps: int
    tag: str


def _escaped(path: str) -> str:
    """Путь внутри значения фильтра — двоеточие закрыто дважды (см. compose)."""
    return path.replace(BACKSLASH, "/").replace(":", BACKSLASH * 2 + ":")


def command_file(lines: list[tuple[float, str]]) -> str:
    """Файл с командами для ``sendcmd``, путь уже подготовлен для фильтра.

    Командами меняют настройки фильтров, которые формулой от времени не
    задаются. Файл, а не строка в команде: на длинном клипе строк тысячи, а
    длина команды в Windows ограничена.
    """
    grouped: dict[float, list[str]] = {}
    for moment, command in lines:
        grouped.setdefault(round(moment, 4), []).append(command)
    text = "\n".join(
        f"{moment:.4f} " + ", ".join(items) + ";" for moment, items in sorted(grouped.items())
    )
    folder = paths.data_dir() / "commands"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{hashlib.sha1(text.encode('utf-8')).hexdigest()[:20]}.txt"
    if not target.exists():
        target.write_bytes(text.encode("utf-8"))
    return _escaped(str(target))


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


def _delogo(effect: ClipEffect, clip: ComposeClip, preview: bool) -> str:
    """Убрать водяной знак: закрасить прямоугольник, подобрав цвет от краёв.

    Место задаётся в процентах картинки, а ffmpeg понимает только пиксели —
    переводим по размеру файла. Повёрнутый на бок клип меняет ширину и высоту
    местами. Прямоугольник обязан лежать внутри кадра с запасом в пиксель:
    иначе ffmpeg отказывается собирать вовсе.
    """
    width, height = clip.source_width, clip.source_height
    if clip.rotate % 180 == 90:
        width, height = height, width
    if width < 8 or height < 8:
        return ""
    w = max(4, round(width * _number(effect, "width", 20, 1, 100) / 100))
    h = max(4, round(height * _number(effect, "height", 12, 1, 100) / 100))
    w = min(w, width - 3)
    h = min(h, height - 3)
    x = round(width * _number(effect, "left", 75, 0, 100) / 100)
    y = round(height * _number(effect, "top", 5, 0, 100) / 100)
    x = min(max(1, x), width - w - 2)
    y = min(max(1, y), height - h - 2)
    # Рамку вокруг области видно только в окне программы: по ней место и
    # подбирают, а в готовый файл она попасть не должна.
    show = 1 if preview and _number(effect, "show", 1, 0, 1) >= 0.5 else 0
    return f"delogo=x={x}:y={y}:w={w}:h={h}:show={show}"


def _keyed(clip: ComposeClip, effect: ClipEffect, param: str) -> bool:
    return param in ANIMATABLE.get(effect.type, ()) and anim.animated(clip, f"fx.{effect.id}.{param}")


def _video_effect(
    effect: ClipEffect, clip: ComposeClip, preview: bool, timing: Timing | None = None
) -> str:
    kind = effect.type

    def field(param: str) -> str:
        return f"fx.{effect.id}.{param}"

    def keyed(param: str) -> bool:
        return timing is not None and _keyed(clip, effect, param)

    moment = f"(t+{timing.skip:.4f})" if timing else "t"
    name = f"{timing.tag}e{clip.effects.index(effect)}" if timing else ""

    def first(param: str, convert: Callable[[float], float]) -> float:
        assert timing is not None
        return convert(anim.value_at(clip, field(param), timing.skip))

    def sent(filter_name: str, options: list[tuple[str, str, Callable[[float], float]]]) -> str:
        """Начало цепочки для фильтра, настройки которого идут командами."""
        assert timing is not None
        lines: list[tuple[float, str]] = []
        for option, param, convert in options:
            lines += anim.commands(
                clip, field(param), f"{filter_name}@{name}", option,
                skip=timing.skip, take=timing.take, fps=timing.fps, scale=convert,
            )
        return f"sendcmd=f={command_file(lines)},"

    if kind == "delogo":
        return _delogo(effect, clip, preview)
    if kind == "color":
        # Шкалы -100…100, ноль — как было.
        def bright(value: float) -> float:
            return max(-100.0, min(100.0, value)) / 100 * 0.3

        def contrast(value: float) -> float:
            return 1 + max(-100.0, min(100.0, value)) / 100 * 0.8

        def saturation(value: float) -> float:
            return 1 + max(-100.0, min(100.0, value)) / 100

        # Теплее — ниже температура, холоднее — выше. 6500 K — нейтральный
        # белый, вдвое ниже — заметно жёлто, вдвое выше — заметно синё.
        def kelvin(value: float) -> float:
            return 6500 * 2 ** (-max(-100.0, min(100.0, value)) / 100)

        if any(keyed(param) for param in ("brightness", "contrast", "saturation")):
            # Формулы от времени — eq пересчитывает их на каждом кадре.
            parts = [
                "eq="
                f"brightness='{anim.expression(clip, field('brightness'), moment, bright)}'"
                f":contrast='{anim.expression(clip, field('contrast'), moment, contrast)}'"
                f":saturation='{anim.expression(clip, field('saturation'), moment, saturation)}'"
                ":eval=frame"
            ]
        else:
            parts = [
                f"eq=brightness={bright(_number(effect, 'brightness', 0, -100, 100)):.3f}"
                f":contrast={contrast(_number(effect, 'contrast', 0, -100, 100)):.3f}"
                f":saturation={saturation(_number(effect, 'saturation', 0, -100, 100)):.3f}"
            ]
        if keyed("temperature"):
            parts.append(
                sent("colortemperature", [("temperature", "temperature", kelvin)])
                + f"colortemperature@{name}=temperature={first('temperature', kelvin):.0f}"
            )
        else:
            warm = _number(effect, "temperature", 0, -100, 100)
            if abs(warm) > 0.5:
                parts.append(f"colortemperature=temperature={kelvin(warm):.0f}")
        return ",".join(parts)
    if kind == "mono":
        def grey(value: float) -> float:
            return 1 - max(0.0, min(100.0, value)) / 100

        if keyed("strength"):
            return f"hue=s='{anim.expression(clip, field('strength'), moment, grey)}'"
        return f"hue=s={grey(_number(effect, 'strength', 100, 0, 100)):.3f}"
    if kind == "blur":
        def sigma(value: float) -> float:
            return max(0.5, min(80.0, value))

        if keyed("strength"):
            return sent("gblur", [("sigma", "strength", sigma)]) + f"gblur@{name}=sigma={first('strength', sigma):.2f}"
        return f"gblur=sigma={_number(effect, 'strength', 10, 0.5, 80):.2f}"
    if kind == "denoise":
        # Соотношение между четырьмя числами — как у обычных настроек фильтра,
        # ползунок двигает их вместе.
        s = _number(effect, "strength", 4, 1, 12)
        return f"hqdn3d={s:.2f}:{s * 0.75:.2f}:{s * 1.5:.2f}:{s * 1.125:.2f}"
    if kind == "pixelate":
        def block(value: float) -> float:
            return float(round(max(2.0, min(120.0, value))))

        if keyed("size"):
            size = int(first("size", block))
            return (
                sent("pixelize", [("w", "size", block), ("h", "size", block)])
                + f"pixelize@{name}=w={size}:h={size}"
            )
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
    if kind == "gain":
        # Усиление одного клипа. Шторка на клипе только приглушает, а
        # поднимать громкость можно было лишь всей дорожке.
        db = _number(effect, "db", 6, 0, 20)
        return f"volume={db:.1f}dB"
    if kind == "echo":
        delay = _number(effect, "delay", 300, 20, 1500)
        decay = _number(effect, "decay", 40, 5, 90) / 100
        return f"aecho=0.8:0.9:{delay:.0f}:{decay:.2f}"
    return ""


def crop_animated(clip: ComposeClip) -> bool:
    return anim.animated(clip, *CROP_FIELDS)


def crop_filter(clip: ComposeClip) -> str:
    """Обрезка: отрезанное прозрачное, оставшееся на своём месте.

    Не просто ``crop``: тот уменьшил бы картинку, и при вписывании в кадр
    оставшаяся часть растянулась бы на всё место клипа. Человек тянет край
    рамки и ждёт, что отрежется край, а не что картинка прыгнет. Поэтому
    после обрезки картинка добивается прозрачными полями до прежнего размера
    — ровно на том месте, где отрезали. Обрезка идёт после поворота и
    отражения: режут то, что видят.

    Обрезка по ключам сюда не попадает — её собирает ``clip_graph``.
    """
    if crop_animated(clip):
        return ""
    left, top = clip.crop_left, clip.crop_top
    right, bottom = clip.crop_right, clip.crop_bottom
    if max(left, top, right, bottom) < 1e-3:
        return ""
    keep_w = max(0.05, 1 - left - right)
    keep_h = max(0.05, 1 - top - bottom)
    return (
        f"crop=w=iw*{keep_w:.5f}:h=ih*{keep_h:.5f}:x=iw*{left:.5f}:y=ih*{top:.5f},"
        "format=yuva420p,"
        f"pad=w=ceil(iw/{keep_w:.5f}/2)*2:h=ceil(ih/{keep_h:.5f}/2)*2"
        f":x=ow*{left:.5f}:y=oh*{top:.5f}:color=black@0"
    )


def base_chain(clip: ComposeClip) -> str:
    """Задом наперёд, скорость, поворот и отражение — с запятой в конце или ""."""
    parts: list[str] = []
    if clip.reverse and clip.kind == "video":
        parts.append("reverse")
    if clip.kind == "video" and abs(clip.speed - 1.0) > 1e-3:
        # Ускорение — сжать время кадров; лишние кадры потом отбросит fps.
        parts.append(f"setpts=(PTS-STARTPTS)/{clip.speed:.4f}")
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
    return ",".join(parts) + "," if parts else ""


def effect_chain(clip: ComposeClip, *, preview: bool = False, timing: Timing | None = None) -> str:
    """Только эффекты из списка — с запятой в конце или ""."""
    parts = [
        chunk
        for effect in clip.effects
        if effect.on and (chunk := _video_effect(effect, clip, preview, timing))
    ]
    return ",".join(parts) + "," if parts else ""


def video_chain(clip: ComposeClip, *, preview: bool = False, timing: Timing | None = None) -> str:
    """Фильтры картинки клипа одной цепочкой — с запятой в конце или "".

    Сначала «задом наперёд», поворот и отражение: эффекты должны видеть кадр
    уже в том виде, в каком его покажут, — иначе пикселизация или хромакей
    считались бы по лежащему на боку кадру. Клипу с маской или обрезкой по
    ключам одной цепочки мало — для них ``clip_graph``.
    """
    parts = [
        base_chain(clip).rstrip(","),
        crop_filter(clip),
        effect_chain(clip, preview=preview, timing=timing).rstrip(","),
    ]
    parts = [part for part in parts if part]
    return ",".join(parts) + "," if parts else ""


def blurred_fill(clip: ComposeClip) -> tuple[float, float] | None:
    """Размытый фон под клипом: насколько размыть и насколько притемнить.

    Это не фильтр цепочки, а другая раскладка клипа: под ним та же картинка,
    растянутая на всё его место и размытая. Поэтому его собирает сама сборка,
    а здесь только настройки. ``None`` — эффекта нет или он выключен.
    """
    for effect in clip.effects:
        if effect.on and effect.type == "blurfill":
            return (
                _number(effect, "strength", 30, 5, 80),
                _number(effect, "dim", 20, 0, 80) / 100,
            )
    return None


def stabilizer(clip: ComposeClip) -> "stabilize.Settings | None":
    """Настройки стабилизатора или ``None``, если его нет или он выключен."""
    if clip.kind != "video":
        return None
    for effect in clip.effects:
        if effect.on and effect.type == "stabilize":
            return stabilize.Settings.from_params(effect.params)
    return None


def preview_factor(clip: ComposeClip, width: int, height: int) -> float:
    """Во сколько раз можно уменьшить файл для окна программы.

    Столько, чтобы клип в кадре просмотра всё ещё был не мельче своего
    места: у крупного (увеличенного) клипа запас больше.
    """
    if not clip.source_width or not clip.source_height:
        return 1.0
    grow = max(1.0, clip.size, clip.size_y, *(key.v for key in clip.anim.get("size", [])))
    side = max(width, height) * grow
    return min(1.0, side / max(clip.source_width, clip.source_height))


def scaled_for_preview(clip: ComposeClip, factor: float) -> ComposeClip:
    """Копия клипа для уменьшенного файла: всё, что задано в пикселях файла.

    Размер файла (им считаются маска и водяной знак), сила размытия и
    размер квадратов пикселизации — иначе на уменьшенном файле размытие
    вышло бы сильнее, а квадраты крупнее, чем в готовом файле.
    """
    copy = clip.model_copy(deep=True)
    copy.source_width = max(2, int(clip.source_width * factor / 2) * 2)
    copy.source_height = max(2, int(clip.source_height * factor / 2) * 2)
    pixel = {"blur": "strength", "pixelate": "size"}
    for effect in copy.effects:
        param = pixel.get(effect.type)
        if not param:
            continue
        try:
            effect.params[param] = float(effect.params.get(param, 0)) * factor
        except (TypeError, ValueError):
            pass
        field = f"fx.{effect.id}.{param}"
        for key in copy.anim.get(field, []):
            key.v *= factor
    return copy


def has_mask(clip: ComposeClip) -> bool:
    return clip.kind in {"video", "image"} and clip.mask is not None and clip.mask.on


def needs_graph(clip: ComposeClip) -> bool:
    """Нужен ли клипу граф, а не одна цепочка: маска или обрезка по ключам."""
    return has_mask(clip) or crop_animated(clip)


def needs_size(clip: ComposeClip) -> bool:
    """Нужен ли сборке размер файла в пикселях."""
    return has_mask(clip) or any(effect.on and effect.type == "delogo" for effect in clip.effects)


def mask_size(clip: ComposeClip) -> tuple[int, int]:
    """Размер кадра клипа после поворота — в нём считается маска."""
    width, height = clip.source_width, clip.source_height
    if clip.rotate % 180 == 90:
        width, height = height, width
    return width, height


def feather_animated(clip: ComposeClip) -> bool:
    """Мягкость края маски меняется по ключам.

    Тогда картинка формы рисуется резкой, а мягкий край даёт размытие уже
    собранной маски — его силу можно менять на каждом кадре командой.
    """
    return has_mask(clip) and anim.animated(clip, "mask.feather")


def _feather(clip: ComposeClip) -> float:
    """Мягкость, нарисованная в самой картинке формы."""
    assert clip.mask is not None
    return 0.0 if feather_animated(clip) else clip.mask.feather


def mask_margin(clip: ComposeClip) -> tuple[float, float]:
    """Запас вокруг формы на картинке маски — под мягкий край, в долях формы."""
    assert clip.mask is not None
    width, height = mask_size(clip)
    box_w = max(clip.mask.w * width, 2.0)
    box_h = max(clip.mask.h * height, 2.0)
    soft = _feather(clip) * min(box_w, box_h) / 2
    return soft / box_w, soft / box_h


def shape_render(clip: ComposeClip) -> tuple[tuple[int, int], str, float]:
    """Как нарисовать картинку формы маски: размер, выражение `geq`, размытие.

    Картинка — сама форма во весь прямоугольник маски плюс запас под мягкий
    край; на кадре её растягивают до нужного размера. Своя форма рисуется
    резкой (точка внутри многоугольника — по числу пересечений его сторон
    лучом), а мягкий край ей даёт размытие.
    """
    assert clip.mask is not None
    m = clip.mask
    width, height = mask_size(clip)
    box_w = max(m.w * width, 8.0)
    box_h = max(m.h * height, 8.0)
    # Картинка формы — не больше тысячи точек по длинной стороне: её всё равно
    # растягивают, а рисуется она попиксельно.
    ratio = min(1.0, 1000.0 / max(box_w, box_h))
    box_w, box_h = box_w * ratio, box_h * ratio
    px, py = mask_margin(clip)
    full_w = max(8, int(round(box_w * (1 + 2 * px))))
    full_h = max(8, int(round(box_h * (1 + 2 * py))))
    left, top = px * box_w, py * box_h
    hw, hh = box_w / 2, box_h / 2
    cx, cy = left + hw, top + hh
    feather = _feather(clip)
    soft = max(0.5, feather * min(hw, hh))
    if m.shape == "custom" and len(m.points) >= 3:
        points = [
            (left + min(1.2, max(-0.2, u)) * box_w, top + min(1.2, max(-0.2, v)) * box_h)
            for u, v in m.points
        ]
        terms = []
        for (xi, yi), (xj, yj) in zip(points, points[1:] + points[:1]):
            if abs(yj - yi) < 1e-6:
                continue
            terms.append(
                f"abs(gt({yi:.2f},Y+0.5)-gt({yj:.2f},Y+0.5))"
                f"*lt(X+0.5,{(xj - xi) / (yj - yi):.5f}*(Y+0.5-{yi:.2f})+{xi:.2f})"
            )
        inside = f"mod({'+'.join(terms) or '0'},2)"
        return (full_w, full_h), f"255*{inside}", (soft / 2.5 if feather > 0 else 0.0)
    if m.shape == "ellipse":
        distance = f"(hypot((X-{cx:.2f})/{hw:.2f},(Y-{cy:.2f})/{hh:.2f})-1)*{min(hw, hh):.2f}"
    else:
        distance = f"max(abs(X-{cx:.2f})-{hw:.2f},abs(Y-{cy:.2f})-{hh:.2f})"
    # Мягкий край — только снаружи формы: внутри маска видна целиком.
    return (full_w, full_h), f"255*clip(1-max({distance},0)/{soft:.2f},0,1)", 0.0


def points_animated(clip: ComposeClip) -> bool:
    """Своя форма, у которой по ключам меняются сами точки."""
    return (
        has_mask(clip)
        and clip.mask is not None
        and clip.mask.shape == "custom"
        and anim.animated(clip, "mask.points")
    )


#: Длинная сторона кадров маски со своей формой, меняющейся по ключам. Их
#: рисует сама программа, кадр за кадром, — крупнее незачем: край потом
#: всё равно размывается и растягивается до размера клипа.
SEQUENCE_SIDE = 480


def sequence_size(clip: ComposeClip) -> tuple[int, int]:
    width, height = mask_size(clip)
    ratio = min(1.0, SEQUENCE_SIDE / max(width, height, 1))
    return max(8, int(round(width * ratio / 2)) * 2), max(8, int(round(height * ratio / 2)) * 2)


def sequence_frame(clip: ComposeClip, local: float, size: tuple[int, int]) -> bytes:
    """Один кадр маски своей формы: белый многоугольник на чёрном, байты gray.

    Заливка по строкам: на каждой строке находим, где её пересекают стороны
    многоугольника, и закрашиваем промежутки через один — внутри то, что
    между нечётным и чётным пересечением.
    """
    assert clip.mask is not None
    width, height = size
    x = anim.value_at(clip, "mask.x", local)
    y = anim.value_at(clip, "mask.y", local)
    w = anim.value_at(clip, "mask.w", local)
    h = anim.value_at(clip, "mask.h", local)
    points = [
        ((x - w / 2 + u * w) * width, (y - h / 2 + v * h) * height)
        for u, v in anim.points_at(clip, local)
    ]
    canvas = bytearray(width * height)
    if len(points) < 3:
        return bytes(canvas)
    edges = list(zip(points, points[1:] + points[:1]))
    for row in range(height):
        middle = row + 0.5
        crossings = []
        for (x1, y1), (x2, y2) in edges:
            if (y1 > middle) != (y2 > middle):
                crossings.append(x1 + (middle - y1) * (x2 - x1) / (y2 - y1))
        crossings.sort()
        base = row * width
        for start, end in zip(crossings[0::2], crossings[1::2]):
            left = max(0, int(start + 0.5))
            right = min(width, int(end + 0.5))
            if right > left:
                canvas[base + left:base + right] = b"\xff" * (right - left)
    return bytes(canvas)


def _multiply(source: str, matte: str, out: str, tag: str) -> str:
    """Умножить прозрачность картинки на чёрно-белую маску того же размера.

    Умножить, а не заменить: иначе у картинки с прозрачным фоном (логотипа)
    фон стал бы чёрным.
    """
    return (
        f"{source}split[{tag}x][{tag}y];[{tag}y]alphaextract[{tag}al];"
        f"[{tag}al]{matte}blend=all_mode=multiply[{tag}am];[{tag}x][{tag}am]alphamerge{out}"
    )


def clip_graph(
    clip: ComposeClip, source: str, out: str, tag: str, *, shape: str, preview: bool, timing: Timing
) -> str:
    """Граф клипа с маской или обрезкой по ключам: от входа до ``out``.

    Маска — картинка формы (``shape`` — её вход), которую на каждом кадре
    растягивают до нужного размера и кладут на чёрный холст размером с клип;
    так её можно двигать и менять ключами без перерисовки. Холст берётся из
    самого клипа, поэтому совпадает с ним и по размеру, и по времени.

    Эффекты «только внутри» или «только снаружи» — клип раздваивается,
    эффекты считаются на копии, копия вырезается маской и ложится поверх.
    Потом — что видно: внутри, снаружи или всё. Последней идёт обрезка.
    """
    moment = f"(t+{timing.skip:.4f})"
    parts = [f"{source}{base_chain(clip)}format=yuva420p[{tag}0]"]
    current = f"[{tag}0]"
    fx = effect_chain(clip, preview=preview, timing=timing)
    mask = clip.mask if has_mask(clip) and shape else None

    if mask is not None:
        uses: list[str] = []
        if fx and mask.effects_area != "all":
            uses.append("fx")
        if not (mask.show_inside and mask.show_outside):
            uses.append("vis")
    else:
        uses = []

    if mask is not None and uses:
        width, height = mask_size(clip)
        if points_animated(clip):
            # Своя форма с меняющимися точками — готовые кадры маски (их
            # рисует программа, см. ``sequence_frame``): растягиваем до
            # размера клипа, мягкий край — размытием, и только наружу:
            # удвоенная яркость размытого края внутри формы снова белая.
            box = min(mask.w * width, mask.h * height)
            sigma = _feather(clip) * box / 2 / 2.5
            soft = f",gblur=sigma={sigma:.2f},lut=c0='min(255,2*val)'" if sigma > 0.3 else ""
            parts.append(
                f"{shape}setpts=PTS-STARTPTS,format=gray,scale={width}:{height}:flags=bilinear{soft}[{tag}m]"
            )
        else:
            px, py = mask_margin(clip)
            wide = anim.expression(clip, "mask.w", moment)
            tall = anim.expression(clip, "mask.h", moment)
            parts.append(f"{current}split[{tag}1][{tag}mc]")
            current = f"[{tag}1]"
            parts.append(f"[{tag}mc]format=gray,lut=c0=0[{tag}mb]")
            parts.append(
                f"{shape}format=gray,scale=w='max(2,{width}*({wide})*{1 + 2 * px:.5f})'"
                f":h='max(2,{height}*({tall})*{1 + 2 * py:.5f})':eval=frame[{tag}ms]"
            )
            parts.append(
                f"[{tag}mb][{tag}ms]overlay=x='W*({anim.expression(clip, 'mask.x', moment)})-w/2'"
                f":y='H*({anim.expression(clip, 'mask.y', moment)})-h/2':eval=frame,format=gray[{tag}m]"
            )
        if feather_animated(clip):
            # Мягкий край по ключам: размываем уже собранную маску, силу
            # размытия шлёт sendcmd на каждый кадр. Удвоенная яркость
            # оставляет край мягким только снаружи, как и без ключей.
            lines: list[tuple[float, str]] = []
            last = ""
            for number in range(max(1, int(math.ceil(timing.take * timing.fps)) + 1)):
                local = number / timing.fps + timing.skip
                box = min(
                    anim.value_at(clip, "mask.w", local) * width,
                    anim.value_at(clip, "mask.h", local) * height,
                )
                sigma = f"{max(0.01, anim.value_at(clip, 'mask.feather', local) * box / 2 / 2.5):.2f}"
                if sigma != last:
                    lines.append((number / timing.fps, f"gblur@{tag}mg sigma {sigma}"))
                    last = sigma
            first = lines[0][1].rsplit(" ", 1)[1]
            parts.append(
                f"[{tag}m]sendcmd=f={command_file(lines)},gblur@{tag}mg=sigma={first},"
                f"lut=c0='min(255,2*val)'[{tag}mf]"
            )
            matte = f"[{tag}mf]"
        else:
            matte = f"[{tag}m]"
        if len(uses) == 2:
            parts.append(f"{matte}split[{tag}mfx][{tag}mvis]")
            matte_for = {"fx": f"[{tag}mfx]", "vis": f"[{tag}mvis]"}
        else:
            matte_for = {uses[0]: matte}

        if "fx" in matte_for:
            parts.append(f"{current}split[{tag}o][{tag}e]")
            parts.append(f"[{tag}e]{fx}format=yuva420p[{tag}f]")
            area = matte_for["fx"]
            if mask.effects_area == "outside":
                parts.append(f"{area}lut=c0='255-val'[{tag}fo]")
                area = f"[{tag}fo]"
            parts.append(_multiply(f"[{tag}f]", area, f"[{tag}fm]", f"{tag}f"))
            parts.append(f"[{tag}o][{tag}fm]overlay=format=auto:shortest=1,format=yuva420p[{tag}2]")
            current = f"[{tag}2]"
        elif fx:
            parts.append(f"{current}{fx}format=yuva420p[{tag}2]")
            current = f"[{tag}2]"

        if "vis" in matte_for:
            visible = matte_for["vis"]
            if mask.show_outside and not mask.show_inside:
                parts.append(f"{visible}lut=c0='255-val'[{tag}vo]")
                visible = f"[{tag}vo]"
            elif not mask.show_inside and not mask.show_outside:
                parts.append(f"{visible}lut=c0=0[{tag}vo]")
                visible = f"[{tag}vo]"
            parts.append(_multiply(current, visible, f"[{tag}3]", f"{tag}v"))
            current = f"[{tag}3]"
    elif fx:
        parts.append(f"{current}{fx}format=yuva420p[{tag}2]")
        current = f"[{tag}2]"

    if crop_animated(clip):
        # Обрезка по ключам — белое окно с резким краем на чёрном холсте,
        # размер и место — формулами от времени.
        left = anim.expression(clip, "cropLeft", moment)
        top = anim.expression(clip, "cropTop", moment)
        right = anim.expression(clip, "cropRight", moment)
        bottom = anim.expression(clip, "cropBottom", moment)
        parts.append(f"{current}split[{tag}4][{tag}cc]")
        parts.append(f"[{tag}cc]format=gray,split[{tag}cb0][{tag}cw0]")
        parts.append(f"[{tag}cb0]lut=c0=0[{tag}cb]")
        parts.append(
            f"[{tag}cw0]lut=c0=255,scale=w='max(2,iw*(1-({left})-({right})))'"
            f":h='max(2,ih*(1-({top})-({bottom})))':eval=frame[{tag}cw]"
        )
        parts.append(
            f"[{tag}cb][{tag}cw]overlay=x='W*({left})':y='H*({top})':eval=frame,format=gray[{tag}cm]"
        )
        parts.append(_multiply(f"[{tag}4]", f"[{tag}cm]", f"[{tag}5]", f"{tag}c"))
        current = f"[{tag}5]"
    else:
        crop = crop_filter(clip)
        if crop:
            parts.append(f"{current}{crop}[{tag}5]")
            current = f"[{tag}5]"

    parts.append(f"{current}null{out}")
    return ";".join(parts)


def audio_chain(clip: ComposeClip) -> str:
    """Фильтры звука клипа — с запятой в конце или пустая строка."""
    parts: list[str] = []
    if clip.reverse:
        parts.append("areverse")
    if abs(clip.speed - 1.0) > 1e-3:
        # atempo меняет скорость, не трогая высоту голоса, — без «бурундука».
        # Медленнее половины за один раз он не умеет — тогда дважды по корню.
        if clip.speed < 0.5:
            half = clip.speed ** 0.5
            parts.append(f"atempo={half:.4f},atempo={half:.4f}")
        else:
            parts.append(f"atempo={clip.speed:.4f}")
    for effect in clip.effects:
        if effect.on:
            chunk = _audio_effect(effect)
            if chunk:
                parts.append(chunk)
    return ",".join(parts) + "," if parts else ""
