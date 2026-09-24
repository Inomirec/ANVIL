"""Монтаж: превращение таймлайна в команду ffmpeg.

Здесь нет запуска процессов — только сборка аргументов, как в ``encode.py``.
Одна и та же функция строит и кадр под иглой, и черновик куска, и итоговый
файл: разница лишь в том, какой отрезок времени просят и чем кодируют.

Главный приём — **в команду попадают только те клипы, которые живут в
запрошенном отрезке**. Кадру под иглой обычно нужен один-два файла, а не весь
монтаж, поэтому игла бегает быстро даже в длинном проекте: замер на монтаже из
четырёх картинок, двух роликов и музыки дал 0.09-0.14 с на кадр.

Как устроена команда:

* каждый клип — отдельный вход ``-i``; картинке дополнительно нужен ``-loop 1``,
  иначе она кончится через один кадр;
* ``-ss``/``-t`` перед входом отрезают от файла ровно нужный кусок — читать
  остальное незачем;
* ``scale``+``pad`` вписывают чужой кадр в кадр проекта, не обрезая его;
* ``setpts=PTS-STARTPTS+смещение/TB`` ставит клип на своё место во времени;
* ``overlay`` кладёт дорожки одна на другую снизу вверх;
* ``adelay``+``amix`` делают то же со звуком.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import math
import time
from pathlib import Path

from .. import paths
from ..models import ComposeClip, ComposeProject
from . import anim, binaries, effects, fonts, fsutil, stabilize
from .probe import probe

#: Черновой кодек: быстрее всего, что есть. Черновик живёт секунды и нужен
#: только чтобы посмотреть, поэтому вес и качество здесь не важны.
DRAFT_CODEC = [
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p",
]

#: Затухание короче этого не пишем в команду. Клипы, поставленные встык,
#: пересекаются на миллионные доли секунды — обычная погрешность дробных
#: чисел. На слух такого затухания нет, а ffmpeg от него падал: очень малое
#: число записывается в научном виде (``1.77636e-15``), а он такую запись
#: длительности не понимает. Поэтому все длительности ниже выводятся как
#: обычные дроби (``.3f``), а совсем короткие отбрасываются.
MIN_FADE = 0.01

#: Обратный слэш. В путях меняем его на прямой, а двоеточие закрываем им же.
BACKSLASH = chr(92)
#: Знаки конца строки: возврат каретки и перевод строки.
CARRIAGE_RETURN = chr(13)
LINE_FEED = chr(10)


def apply_crossfades(project: ComposeProject) -> None:
    """Делает перетекание там, где клипы наложились друг на друга.

    Наложение — это и есть просьба о переходе: человек подвинул кусок на
    соседа, потому что хочет, чтобы один сменился другим, а не чтобы верхний
    просто закрыл нижний резкой границей. Поэтому в зоне пересечения верхний
    (тот, что начинается позже) проявляется, а нижний уходит — и картинка, и
    звук.

    Руками заданное затухание сильнее: если человек сам вытянул уголок
    длиннее, чем зона наложения, остаётся его значение.
    """
    for track in project.tracks:
        clips = sorted(track.clips, key=lambda clip: clip.start)
        for lower, upper in zip(clips, clips[1:]):
            overlap = (lower.start + lower.duration) - upper.start
            if overlap <= MIN_FADE:
                continue
            # Перехлёст не может быть длиннее самих клипов.
            span = min(overlap, lower.duration, upper.duration)
            upper.fade_in = max(upper.fade_in, span)
            lower.fade_out = max(lower.fade_out, span)


def clips_at(project: ComposeProject, at: float, span: float) -> list[tuple[int, ComposeClip]]:
    """Клипы, попадающие в отрезок ``[at, at+span]``, снизу вверх по слоям.

    Возвращает вместе с номером дорожки: он задаёт порядок наложения. Верхняя
    дорожка на таймлайне — верхний слой в кадре, как в монтажных программах,
    поэтому нижние дорожки идут первыми. Внутри одной дорожки выше тот клип,
    который начинается позже.
    """
    found: list[tuple[int, ComposeClip]] = []
    for layer, track in enumerate(project.tracks):
        for clip in track.clips:
            if clip.start < at + span and clip.end > at:
                # Уровень дорожки складываем с уровнем клипа здесь, а не
                # правим сам клип: тогда сборку можно звать сколько угодно раз
                # подряд, и громкость не будет умножаться сама на себя.
                if track.level != 1.0:
                    clip = clip.model_copy(update={
                        "volume": min(4.0, clip.volume * track.level),
                        "opacity": min(1.0, clip.opacity * track.level),
                    })
                found.append((layer, clip))
    found.sort(key=lambda item: (-item[0], item[1].start))
    return found


def _window(clip: ComposeClip, at: float, span: float) -> tuple[float, float, float]:
    """Что берём от клипа в этом окне: откуда читать, сколько и когда показать.

    У клипа «задом наперёд» кусок берётся с другого конца: начало окна — это
    конец отрезка файла. Прочитанный кусок потом разворачивает фильтр
    ``reverse`` — так и кадр под иглой, и кусок просмотра показывают ровно то
    место, что окажется в готовом файле.
    """
    # Сколько клипа уже прошло к началу окна. Всё, что про время таймлайна,
    # в секундах таймлайна; про файл — умножаем на скорость: ускоренный вдвое
    # клип за секунду таймлайна проходит две секунды файла.
    skip = max(0.0, at - clip.start)
    offset = max(0.0, clip.start - at)
    take = max(min(clip.duration - skip, span - offset), 0.0)
    speed = clip.speed if clip.kind in {"video", "audio"} else 1.0
    if clip.reverse:
        seek = clip.source_in + max(0.0, clip.duration - skip - take) * speed
    else:
        seek = clip.source_in + skip * speed
    return seek, take, offset


def _still_seek(clip: ComposeClip, at: float, fps: int) -> float:
    """Откуда читать ролик ради одного кадра под иглой.

    В готовом файле кадр монтажа показывает последний кадр ролика, который
    успел начаться к этому моменту (``fps`` округляет время кадра до
    ближайшего кадра монтажа). Чтение с ``-ss`` же отдаёт первый кадр *после*
    момента — и на склейке окно просмотра показывало уже новую сцену, когда в
    файле была ещё прежняя. Поэтому ищем начало нужного кадра сами, по сетке
    кадров ролика.
    """
    rate = clip.source_fps
    skip = max(0.0, at - clip.start)
    limit = clip.source_in + (skip + 0.5 / max(fps, 1)) * clip.speed
    frame = max(0, math.ceil(limit * rate - 1e-6) - 1)
    return max(clip.source_in, frame / rate - 0.25 / rate, 0.0)


def fit_filter(width: int, height: int, fps: int) -> str:
    """Вписать чужой кадр в кадр проекта, добив поля чёрным.

    Именно вписать, а не обрезать: человек положил на дорожку свой файл и не
    ожидает, что программа отрежет ему полкадра. Вертикальное видео в
    горизонтальном проекте получит чёрные поля по бокам — так же, как это
    делают монтажные программы.

    Поля прозрачные, а не чёрные. Под нижним слоем и так лежит чёрный фон, так
    что на глаз разницы нет, зато на верхних слоях сквозь поля виден нижний:
    иначе логотип с прозрачностью, положенный поверх видео, закрывал бы его
    чёрными полосами по бокам.
    """
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,"
        f"format=yuva420p,pad={width}:{height}:-1:-1:color=black@0,setsar=1,fps={fps}"
    )


def _even(value: int) -> int:
    """Кодировщики не берут нечётные размеры кадра."""
    return max(2, value - value % 2)


def _even_pixels(expression: str) -> str:
    """То же округление до чётного, но для выражения внутри команды ffmpeg.

    Часть значений известна только самому ffmpeg — например ширина картинки
    после подгонки размера, — поэтому считать их заранее нечем.
    """
    return f"2*round(({expression})/2)"


def _even_near(value: float) -> int:
    """То же, но к ближайшему чётному, а не всегда вниз.

    Округление вниз само по себе сдвигало клип: середина стоит там, где её
    поставили, а ширина отнималась только с одной стороны — и край уезжал
    вправо на полпикселя. На сетке из одинаковых картинок это видно сразу:
    ряд выглядит неровным.
    """
    return max(2, int(round(value / 2)) * 2)


def zoom_filter(clip: ComposeClip, width: int, height: int) -> str:
    """Приближение внутри кадра: увеличиваем и обрезаем по краям."""
    if clip.zoom <= 1.0:
        return ""
    big_w = max(2, int(width * clip.zoom) // 2 * 2)
    big_h = max(2, int(height * clip.zoom) // 2 * 2)
    return f",scale={big_w}:{big_h}:flags=lanczos,crop={width}:{height}"


#: Показатели места и размера клипа в кадре.
PLACE_FIELDS = ("x", "y", "size", "sizeY")


def animated(clip: ComposeClip) -> bool:
    """Меняются ли место или размер клипа по ключам."""
    return clip.kind in {"video", "image", "color"} and anim.animated(clip, *PLACE_FIELDS)


def animated_place_filter(clip: ComposeClip, width: int, height: int, fps: int, skip: float) -> str:
    """Размер по ключам, кадр за кадром.

    ``t`` внутри цепочки клипа отсчитывается от начала прочитанного куска, а
    ключи — от начала клипа; ``skip`` — сколько клипа прошло до куска.
    """
    moment = f"(t+{skip:.4f})"
    size = anim.expression(clip, "size", moment)
    tall = anim.expression(clip, "sizeY", moment)
    if clip.kind == "color":
        if clip.fill_image:
            # Картинка заливки нарисована под размер без ключей — вместе с
            # запасом под тень растягиваем её в той же пропорции.
            base_w = max(clip.size, 1e-3)
            base_h = max(clip.size_y if clip.size_y > 0 else clip.size, 1e-3)
            return (
                f"format=rgba,scale=w='max(2,trunc(iw*({size})/{base_w:.5f}/2)*2)'"
                f":h='max(2,trunc(ih*({tall})/{base_h:.5f}/2)*2)':eval=frame,setsar=1,fps={fps}"
            )
        # У сплошного цвета формы нет — он занимает место целиком.
        return (
            f"scale=w='max(2,trunc({width}*({size})/2)*2)':h='max(2,trunc({height}*({tall})/2)*2)'"
            f":eval=frame,setsar=1,fps={fps}"
        )
    return (
        f"scale=w='max(2,trunc({width}*({size})/2)*2)':h='max(2,trunc({height}*({tall})/2)*2)'"
        f":force_original_aspect_ratio=decrease:eval=frame:flags=bicubic,setsar=1,fps={fps}"
    )


def is_placed(clip: ComposeClip) -> bool:
    """Двигали ли клип по кадру или меняли его размер."""
    if animated(clip):
        return True
    if clip.kind == "text":
        # У надписи двигается сам текст внутри слоя, а слой всегда во весь
        # кадр: иначе буквы пришлось бы масштабировать вместе с ним.
        return False
    if is_decorated_fill(clip):
        # Украшенная заливка — готовая картинка своего размера. Вписывать её
        # в кадр с полями нельзя: рамка и тень оказались бы не на месте.
        return True
    return (
        abs(clip.size - 1.0) > 1e-6
        or clip.size_y > 0
        or abs(clip.x - 0.5) > 1e-6
        or abs(clip.y - 0.5) > 1e-6
    )


def clip_box(clip: ComposeClip, width: int, height: int) -> tuple[int, int]:
    """Прямоугольник, отведённый клипу, в пикселях кадра.

    Это именно место под клип, а не сам клип: картинка вписывается внутрь,
    сохраняя свою форму, поэтому вертикальное видео займёт только середину
    прямоугольника. Считать высоту по форме файла нельзя — у вертикального
    ролика такое «место» вылезало за кадр в несколько раз, и размер прыгал.
    """
    tall = clip.size_y if clip.size_y > 0 else clip.size
    return _even_near(width * clip.size), _even_near(height * tall)


def place_filter(clip: ComposeClip, width: int, height: int, fps: int, skip: float = 0.0) -> str:
    """Во весь кадр или своим размером в своём месте.

    Нетронутый клип вписывается в кадр как обычно — с чёрными полями, если
    форма не совпала. Переставленному или изменённому поля не нужны и вредны:
    чёрная рамка вокруг накрыла бы то, что лежит под ним, а ради этого
    «картинку в картинке» и делают. Размер считается от кадра: 0.5 — вчетверо
    меньше, 2 — вдвое крупнее кадра, лишнее уйдёт за края.

    Приближение у переставленного клипа отрезает края у **исходника**, до
    подгонки размера, — иначе картинку растянуло бы.
    """
    if clip.kind == "text":
        # Слой уже размером с кадр — подгонять нечего, остаётся написать.
        return f"{text_filter(clip, width, height, skip)},setsar=1,fps={fps}"

    if not is_placed(clip):
        return fit_filter(width, height, fps) + zoom_filter(clip, width, height)

    if clip.kind == "color" and clip.fill_image:
        return f"format=rgba,setsar=1,fps={fps}"

    box_w, box_h = clip_box(clip, width, height)
    parts: list[str] = []
    if clip.zoom > 1.0:
        parts.append(f"crop=iw/{clip.zoom:.3f}:ih/{clip.zoom:.3f}")
    # Заливка занимает прямоугольник целиком: у сплошного цвета формы нет, и
    # вписывать его с полями бессмысленно. Картинка и ролик форму сохраняют —
    # растянутое лицо человек точно не заказывал.
    fit = "" if clip.kind == "color" else ":force_original_aspect_ratio=decrease"
    parts.append(f"scale={box_w}:{box_h}{fit}:flags=lanczos")
    parts.append("setsar=1")
    parts.append(f"fps={fps}")
    return ",".join(parts)


#: Сколько держим файлы с надписями, прежде чем убрать за собой.
_TEXT_AGE = 6 * 3600


def _escaped(path: str) -> str:
    """Путь внутри значения фильтра ffmpeg.

    Двоеточие разделяет настройки фильтра, поэтому в «C:/Windows» его надо
    закрыть — причём **дважды**: строку разбирают в два захода, и одиночный
    обратный слэш съедается на первом. С одним ffmpeg отвечает «No option
    name near '/Windows/...'». Слэши заодно разворачиваем в прямые: их
    понимают обе стороны.
    """
    return path.replace(BACKSLASH, "/").replace(":", BACKSLASH * 2 + ":")


def _colour(value: str, alpha: float = 1.0) -> str:
    """Цвет для ffmpeg: решётку он не понимает, прозрачность пишется через @."""
    clean = value.lstrip("#")
    if alpha >= 1.0:
        return f"0x{clean}"
    return f"0x{clean}@{max(0.0, alpha):.3f}"


def text_file(text: str) -> Path:
    """Кладёт надпись в файл и отдаёт путь к нему.

    Текст передаём файлом, а не прямо в команду: в надписи бывают двоеточия,
    кавычки, проценты и переводы строк — всё то, что ffmpeg разбирает как
    разметку, и экранировать это вручную значит однажды ошибиться. Имя файла
    считаем по самому тексту, поэтому одна и та же надпись не плодит копий.
    """
    folder = paths.data_dir() / "text"
    folder.mkdir(parents=True, exist_ok=True)
    # Перевод строки — только один знак. Записанный обычным способом, текст на
    # Windows получал на каждый перевод пару знаков «возврат каретки + перевод
    # строки», и ffmpeg засчитывал оба: между строками надписи в готовом
    # файле вставала пустая строка. Пишем байты сами.
    clean = text.replace(CARRIAGE_RETURN + LINE_FEED, LINE_FEED).replace(CARRIAGE_RETURN, LINE_FEED)
    stamp = hashlib.sha1(clean.encode("utf-8")).hexdigest()[:16]
    # Приставка в имени — чтобы не взять из кэша файл, записанный по-старому.
    target = folder / f"lf-{stamp}.txt"
    if not target.exists():
        target.write_bytes(clean.encode("utf-8"))
    # Заодно подчищаем надписи, которые больше никому не нужны.
    edge = time.time() - _TEXT_AGE
    for stale in folder.glob("*.txt"):
        with contextlib.suppress(OSError):
            if stale.stat().st_mtime < edge:
                stale.unlink()
    return target


def text_filter(clip: ComposeClip, width: int, height: int, skip: float = 0.0) -> str:
    """Фильтр, рисующий надпись клипа на прозрачном слое.

    Размеры считаем от высоты кадра, а не в пикселях: тот же монтаж,
    переведённый с 720p на 1080p, должен выглядеть так же, а не втрое мельче.
    """
    size = max(1, round(height * clip.font_size))
    where = fonts.path_for(clip.font, clip.bold, clip.italic)
    parts = [f"textfile={_escaped(str(text_file(clip.text)))}"]
    if where:
        parts.append(f"fontfile={_escaped(where)}")
    parts.append(f"fontsize={size}")
    parts.append(f"fontcolor={_colour(clip.text_color)}")

    # Строки между собой равняются по середине: у субтитров в две строки
    # разной длины это единственный вид, который не выглядит случайным.
    if clip.align != "left":
        parts.append(f"text_align={'C' if clip.align == 'center' else 'R'}")
    # Строки идут на ту высоту, что записана в самом шрифте, — без добавок.
    # Окно берёт её из того же файла (`fonts.line_height`), поэтому надпись в
    # окне и в готовом файле разбита на строки одинаково.

    # Обводка и тень: без них светлый текст пропадает на светлом кадре.
    if clip.stroke_on and clip.stroke > 0:
        parts.append(f"borderw={max(1, round(height * clip.stroke))}")
        parts.append(f"bordercolor={_colour(clip.stroke_color)}")
    if (
        clip.shadow_on
        and clip.shadow_alpha > 0
        and (abs(clip.shadow_x) > 1e-6 or abs(clip.shadow_y) > 1e-6)
    ):
        parts.append(f"shadowx={round(height * clip.shadow_x)}")
        parts.append(f"shadowy={round(height * clip.shadow_y)}")
        parts.append(f"shadowcolor={_colour(clip.shadow_color, clip.shadow_alpha)}")
    if clip.box:
        parts.append("box=1")
        parts.append(f"boxcolor={_colour(clip.box_color, clip.box_alpha)}")
        parts.append(f"boxborderw={max(0, round(height * clip.box_pad))}")

    # Куда встанет надпись. x и y клипа — это её середина в долях кадра, так
    # же как у картинок: человек двигает текст той же рамкой.
    # По ключам место меняется формулой от времени: слой надписи начинается
    # с начала прочитанного куска, ``skip`` — сколько клипа прошло до него.
    moment = f"(t+{skip:.4f})"
    middle_x = f"w*({anim.expression(clip, 'x', moment)})"
    middle_y = f"h*({anim.expression(clip, 'y', moment)})"
    if clip.align == "left":
        parts.append(f"x='{middle_x}'")
    elif clip.align == "right":
        parts.append(f"x='{middle_x}-text_w'")
    else:
        parts.append(f"x='{middle_x}-text_w/2'")
    parts.append(f"y='{middle_y}-text_h/2'")
    return "drawtext=" + ":".join(parts)


def is_decorated_fill(clip: ComposeClip) -> bool:
    """Заливка со скруглением, рамкой или тенью — её рисуем картинкой."""
    if clip.kind != "color":
        return False
    shadow = clip.shadow_on and clip.shadow_alpha > 0 and (
        abs(clip.shadow_x) > 1e-6 or abs(clip.shadow_y) > 1e-6
    )
    return clip.radius > 0 or (clip.stroke_on and clip.stroke > 0) or shadow


def _box_alpha(left: float, top: float, width: float, height: float, radius: float, alpha: float) -> str:
    """Выражение `geq` для прозрачности скруглённого прямоугольника.

    Считается расстояние от точки до края прямоугольника со скруглёнными
    углами: внутри оно меньше нуля, снаружи больше. Полпикселя по краю дают
    мягкую границу — без неё скругление выходило ступеньками.
    """
    cx = left + width / 2
    cy = top + height / 2
    hx = max(width / 2 - radius, 0.0)
    hy = max(height / 2 - radius, 0.0)
    qx = f"(abs(X+0.5-{cx:.3f})-{hx:.3f})"
    qy = f"(abs(Y+0.5-{cy:.3f})-{hy:.3f})"
    distance = f"(hypot(max({qx},0),max({qy},0))+min(max({qx},{qy}),0)-{radius:.3f})"
    return f"{255 * alpha:.3f}*clip(0.5-{distance},0,1)"


def _layer(colour: str, size: tuple[int, int], expression: str) -> list[str]:
    """Вход ffmpeg: слой одного цвета, прозрачный вне фигуры."""
    width, height = size
    return [
        "-f", "lavfi", "-i",
        f"color=c={_colour(colour)}:s={width}x{height}:d=0.04,format=rgba,"
        f"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='{expression}'",
    ]


def fill_margin(clip: ComposeClip, height: int) -> int:
    """Сколько места нужно вокруг заливки под тень, в пикселях.

    Чётное: наложение в видео встаёт на чётные позиции, и нечётный запас
    сдвигал бы заливку на пиксель относительно её места.
    """
    if not (clip.shadow_on and clip.shadow_alpha > 0):
        return 0
    reach = max(abs(clip.shadow_x), abs(clip.shadow_y)) * height
    return int(math.ceil(reach / 2)) * 2


async def _render_fill(clip: ComposeClip, width: int, height: int) -> Path:
    """Рисует заливку картинкой: скругление, рамка, тень.

    Сплошной цвет ffmpeg отдаёт сам, а вот скруглить углы, обвести и уронить
    тень он не умеет — это рисуется попиксельно (`geq`). Попиксельный счёт
    медленный, поэтому делается один раз на одну форму и лежит в кэше: при
    сборке длинного монтажа заливка повторяет готовую картинку, а не считает
    каждый кадр заново.
    """
    box_w, box_h = clip_box(clip, width, height) if is_placed(clip) else (width, height)
    margin = fill_margin(clip, height)
    canvas = (box_w + 2 * margin, box_h + 2 * margin)
    radius = min(clip.radius * height, min(box_w, box_h) / 2)
    border = clip.stroke * height if clip.stroke_on and clip.stroke > 0 else 0.0

    stamp = "|".join(
        str(item)
        for item in (
            canvas, box_w, box_h, margin, round(radius, 2), round(border, 2), clip.color,
            clip.stroke_color, clip.shadow_on, round(clip.shadow_x * height, 2),
            round(clip.shadow_y * height, 2), clip.shadow_color, clip.shadow_alpha,
        )
    )
    folder = paths.data_dir() / "fills"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{hashlib.sha1(stamp.encode()).hexdigest()[:20]}.png"
    if target.exists():
        return target

    inputs: list[str] = [
        "-f", "lavfi", "-i", f"color=c=black@0:s={canvas[0]}x{canvas[1]}:d=0.04,format=rgba",
    ]
    if margin:
        inputs += _layer(
            clip.shadow_color,
            canvas,
            _box_alpha(
                margin + clip.shadow_x * height, margin + clip.shadow_y * height,
                box_w, box_h, radius, clip.shadow_alpha,
            ),
        )
    if border:
        inputs += _layer(clip.stroke_color, canvas, _box_alpha(margin, margin, box_w, box_h, radius, 1.0))
    inset = min(border, min(box_w, box_h) / 2 - 1)
    inputs += _layer(
        clip.color,
        canvas,
        _box_alpha(
            margin + inset, margin + inset, box_w - 2 * inset, box_h - 2 * inset,
            max(radius - inset, 0.0), 1.0,
        ),
    )

    layers = len(inputs) // 4
    graph = []
    current = "[0:v]"
    for index in range(1, layers):
        nxt = f"[l{index}]"
        graph.append(f"{current}[{index}:v]overlay=format=auto{nxt}")
        current = nxt
    args = [
        binaries.ffmpeg(), "-y", "-v", "error", *inputs,
        "-filter_complex", ";".join(graph), "-map", current,
        "-frames:v", "1", str(target),
    ]
    process = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        creationflags=binaries.CREATE_NO_WINDOW,
        env=binaries.subprocess_env(),
    )
    _, err = await process.communicate()
    if process.returncode != 0 or not target.exists():
        target.unlink(missing_ok=True)
        detail = err.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError("Не удалось нарисовать заливку: " + (detail[-1] if detail else "?"))

    # Старые формы подчищаем: каждое движение ползунка даёт новую картинку.
    edge = time.time() - _TEXT_AGE
    for stale in folder.glob("*.png"):
        with contextlib.suppress(OSError):
            if stale.stat().st_mtime < edge:
                stale.unlink()
    return target


async def _render_mask(clip: ComposeClip) -> Path:
    """Картинка формы маски — из кэша по форме (``effects.shape_render``)."""
    (width, height), expression, blur = effects.shape_render(clip)
    key = hashlib.sha1(f"{width}x{height}|{expression}|{blur:.2f}".encode("utf-8")).hexdigest()[:20]
    folder = paths.data_dir() / "masks"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"s-{key}.png"
    if target.exists():
        return target
    partial = target.with_suffix(".part.png")
    chain = f"geq=lum='{expression}'"
    if blur > 0.3:
        chain += f",gblur=sigma={blur:.2f}"
    process = await asyncio.create_subprocess_exec(
        binaries.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"color=c=black:s={width}x{height}:d=1,format=gray",
        "-vf", chain, "-frames:v", "1", str(partial),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        creationflags=binaries.CREATE_NO_WINDOW,
        env=binaries.subprocess_env(),
    )
    _, err = await process.communicate()
    if process.returncode != 0 or not partial.exists():
        raise RuntimeError("Не удалось нарисовать маску: " + err.decode("utf-8", "replace").strip()[:300])
    partial.replace(target)
    return target


async def _render_mask_sequence(clip: ComposeClip, fps: int) -> Path:
    """Маска своей формы с меняющимися точками — роликом на весь клип.

    Кадры рисует программа (``effects.sequence_frame``) и отдаёт ffmpeg
    сырыми байтами; он складывает их в маленький ролик без потерь. Лежит в
    кэше по форме, ключам и длине клипа: пока их не трогали, второй раз не
    рисуется.
    """
    size = effects.sequence_size(clip)
    frames = max(1, int(math.ceil(clip.duration * fps)) + 1)
    assert clip.mask is not None
    stamp = "|".join([
        clip.mask.model_dump_json(),
        json.dumps({field: [key.model_dump() for key in keys] for field, keys in sorted(clip.anim.items())
                    if field.startswith("mask.")}),
        f"{size}|{frames}|{fps}",
    ])
    folder = paths.data_dir() / "masks"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"q-{hashlib.sha1(stamp.encode('utf-8')).hexdigest()[:20]}.mkv"
    if target.exists():
        return target
    partial = target.with_suffix(".part.mkv")
    process = await asyncio.create_subprocess_exec(
        binaries.ffmpeg(), "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{size[0]}x{size[1]}", "-r", str(fps),
        "-i", "-", "-c:v", "ffv1", str(partial),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        creationflags=binaries.CREATE_NO_WINDOW,
        env=binaries.subprocess_env(),
    )
    assert process.stdin is not None
    for index in range(frames):
        # Рисование — в отдельном потоке: на длинном клипе это секунды, а
        # сервер тем временем должен отвечать.
        frame = await asyncio.to_thread(effects.sequence_frame, clip, index / fps, size)
        process.stdin.write(frame)
        await process.stdin.drain()
    process.stdin.close()
    _, err = await process.communicate()
    if process.returncode != 0 or not partial.exists():
        raise RuntimeError("Не удалось нарисовать маску: " + err.decode("utf-8", "replace").strip()[:300])
    partial.replace(target)
    return target


async def prepare_fills(
    project: ComposeProject, width: int | None = None, height: int | None = None
) -> None:
    """Готовит картинки заливок со скруглением, рамкой и тенью.

    Отдельным шагом и асинхронно: рисует их ffmpeg, и ждать его внутри
    `build_segment`, который зовут прямо из обработчиков, значило бы подвесить
    весь сервер. Размер — тот же, что потом возьмёт сборка.
    """
    frame_w = _even(width or project.width)
    frame_h = _even(height or project.height)
    for track in project.tracks:
        for clip in track.clips:
            if is_decorated_fill(clip):
                clip.fill_image = str(await _render_fill(clip, frame_w, frame_h))
            # Маски — тоже картинки, рисуются здесь же и по той же причине.
            if effects.has_mask(clip) and clip.source_width:
                if effects.points_animated(clip):
                    clip.mask_image = str(await _render_mask_sequence(clip, project.fps))
                else:
                    clip.mask_image = str(await _render_mask(clip))


def frame_alpha(clip: ComposeClip, moment: float) -> float:
    """Насколько клип виден в конкретное мгновение.

    Для одного кадра фильтр ``fade`` не годится: он разворачивается во
    времени, а окно кадра длится одну сороковую секунды — за неё затухание
    успевает подняться на проценты. Из-за этого верхний клип в зоне
    наложения был на кадре почти невидим, хотя в готовом файле проявлялся
    правильно. Поэтому для кадра считаем прозрачность прямо: где игла — такая
    и видимость.
    """
    alpha = clip.opacity
    if clip.fade_in > 0:
        passed = moment - clip.start
        if passed < clip.fade_in:
            alpha *= max(0.0, min(1.0, passed / clip.fade_in))
    if clip.fade_out > 0:
        left = clip.end - moment
        if left < clip.fade_out:
            alpha *= max(0.0, min(1.0, left / clip.fade_out))
    return max(0.0, min(1.0, alpha))


def video_fades(clip: ComposeClip, at: float, take: float, *, moment: float | None = None) -> str:
    """Появление и уход картинки; ``moment`` — для одиночного кадра."""
    if moment is not None:
        alpha = frame_alpha(clip, moment)
        if alpha >= 1.0:
            return ""
        return f",format=yuva420p,colorchannelmixer=aa={alpha:.4g}"
    return _video_fade_filters(clip, at, take)


def _video_fade_filters(clip: ComposeClip, at: float, take: float) -> str:
    """Появление и уход картинки по краям клипа.

    Затухание делаем по прозрачности (``alpha=1``), а не в чёрный: под нижним
    слоем всё равно лежит чёрный фон, и результат тот же, зато на верхних
    дорожках сквозь уходящий клип будет виден нижний — так получается
    перетекание между клипами, без отдельного ``xfade``.
    """
    skip = max(0.0, at - clip.start)
    parts: list[str] = []

    if clip.fade_in - skip > MIN_FADE:
        parts.append(f"fade=t=in:st=0:d={clip.fade_in - skip:.3f}:alpha=1")

    if clip.fade_out > MIN_FADE:
        starts = (clip.duration - skip) - clip.fade_out
        if starts < take:
            parts.append(
                f"fade=t=out:st={max(starts, 0.0):.3f}"
                f":d={min(clip.fade_out, clip.duration):.3f}:alpha=1"
            )

    # Полупрозрачный клип — тот же канал прозрачности, только постоянный.
    if clip.opacity < 1.0:
        parts.append(f"colorchannelmixer=aa={clip.opacity:.3g}")

    if not parts:
        return ""
    # Прозрачности неоткуда взяться в обычном yuv420p — добавляем канал.
    return ",format=yuva420p," + ",".join(parts)


def audio_filter(clip: ComposeClip, at: float, offset: float, take: float) -> str:
    """Цепочка фильтров для звука одного клипа.

    Порядок важен: сначала громкость, потом появление и уход, и только в конце
    сдвиг во времени. Иначе затухание считалось бы от начала всего монтажа, а
    не от начала клипа.

    Появление и уход отсчитываются от краёв **клипа**, а не запрошенного окна.
    Для готовой сборки окно и так начинается с нуля, и всё точно; в
    предпросмотре середины клипа форма кривой может немного отличаться — на
    то, каким получится файл, это не влияет.
    """
    parts = ["aresample=48000"]
    # Эффекты звука и «задом наперёд» — первыми: громкость и затухания
    # относятся уже к тому, что получилось.
    extra = effects.audio_chain(clip)
    if extra:
        parts.append(extra.rstrip(","))
    if abs(clip.volume - 1.0) > 1e-6:
        parts.append(f"volume={clip.volume:.3g}")

    # Сколько клипа осталось за левым краем окна.
    skip = max(0.0, at - clip.start)

    if clip.fade_in - skip > MIN_FADE:
        parts.append(f"afade=t=in:curve=qsin:st=0:d={clip.fade_in - skip:.3f}")

    if clip.fade_out > MIN_FADE:
        # Начало ухода в координатах читаемого куска.
        starts = (clip.duration - skip) - clip.fade_out
        if starts < take:
            parts.append(
                f"afade=t=out:curve=qsin:st={max(starts, 0.0):.3f}"
                f":d={min(clip.fade_out, clip.duration):.3f}"
            )

    shift = int(offset * 1000)
    if shift:
        parts.append(f"adelay={shift}|{shift}")
    return ",".join(parts)


def build_segment(
    project: ComposeProject,
    output: Path,
    *,
    at: float = 0.0,
    span: float | None = None,
    width: int | None = None,
    height: int | None = None,
    still: bool = False,
    codec: list[str] | None = None,
    progress: bool = False,
    preview: bool = False,
) -> list[str]:
    """Команда ffmpeg для отрезка монтажа.

    ``still`` — нужен один кадр (окно просмотра), ``codec`` — чем кодировать;
    без него берётся быстрый черновой H.264. ``progress`` просит ffmpeg
    рассказывать, сколько уже сделано: без этого полоса готовности у задачи
    так и стоит на нуле до самого конца. Кадру и черновику он не нужен — их
    никто не ждёт с полосой.

    ``preview`` — собирается для окна программы (кадр, просмотр), а не файл:
    тогда видны подсказки вроде рамки вокруг убираемого водяного знака.
    """
    span = span if span is not None else max(project.duration - at, 0.0)
    if span <= 0:
        raise ValueError("На таймлайне пусто — нечего собирать")

    # Наложения превращаем в переходы: это касается и кадра под иглой, чтобы
    # человек видел ровно то, что получится в файле.
    apply_crossfades(project)

    width = _even(width or project.width)
    height = _even(height or project.height)
    fps = project.fps

    inputs: list[str] = []
    chain: list[str] = []
    video_labels: list[tuple[str, ComposeClip]] = []
    audio_labels: list[str] = []

    # Чёрный фон на всю длину отрезка. Он же отвечает за пустые места, где ни
    # один клип не стоит: без него дырка на таймлайне обрывала бы сборку.
    chain.append(f"color=c=black:s={width}x{height}:r={fps}:d={span:.3f}[bg]")

    index = 0
    #: Картинки масок: их входы идут после всех клипов.
    masks: list[tuple[str, float]] = []
    for _, clip in clips_at(project, at, span):
        seek, take, offset = _window(clip, at, span)
        if take <= 0:
            continue
        sound = (
            not clip.muted
            and clip.volume > 0
            and (clip.kind == "audio" or (clip.kind == "video" and clip.has_audio))
        )
        # Кадру звук не нужен — и записать его в картинку нельзя.
        if still and clip.kind == "audio":
            continue

        if clip.kind == "text":
            # Надпись живёт на прозрачном слое размером с кадр: масштабировать
            # готовые буквы нельзя — они замылятся, поэтому рисуем их сразу в
            # том размере, в котором они попадут в файл.
            inputs += [
                "-f", "lavfi", "-t", f"{take:.3f}",
                # Прозрачность задаём прямо во входе: добавленная позже, в
                # цепочке фильтров, она уже ничего не значит — слой к тому
                # времени непрозрачный, и надпись закрывает собой весь кадр.
                "-i", f"color=c=black@0:s={width}x{height}:r={fps},format=yuva420p",
            ]
        elif clip.kind == "color" and clip.fill_image:
            # Заливку со скруглением, рамкой и тенью нарисовали заранее —
            # здесь она обычная картинка, повторяемая весь клип.
            inputs += ["-loop", "1", "-t", f"{take:.3f}", "-i", clip.fill_image]
        elif clip.kind == "color":
            # Заливку рисует сам ffmpeg — файла у такого клипа нет. Сразу в
            # нужном размере: масштабировать сплошной цвет незачем.
            box = clip_box(clip, width, height) if is_placed(clip) else (width, height)
            inputs += [
                "-f", "lavfi", "-t", f"{take:.3f}",
                "-i", f"color=c={clip.color}:s={box[0]}x{box[1]}:r={fps}",
            ]
        elif clip.kind == "image":
            # Картинка — один кадр; без повтора она исчезнет сразу же.
            inputs += [*_repeat(clip.source), "-t", f"{take:.3f}", "-i", clip.source]
        else:
            # Стабилизированный ролик читаем из ровной копии: времена в ней те
            # же, что в исходнике, поэтому и обрезка, и разрез на месте.
            source = clip.stable_source or clip.source
            if still and not clip.reverse and clip.source_fps > 0:
                seek = _still_seek(clip, at, fps)
            # Из файла берём столько, сколько пройдёт за окно с этой скоростью.
            inputs += ["-ss", f"{seek:.4f}", "-t", f"{take * clip.speed:.3f}", "-i", source]

        if clip.kind != "audio":
            fades = video_fades(clip, at, take, moment=at if still else None)
            # Откуда берётся картинка клипа. Обычно — прямо со входа, через
            # линейную цепочку фильтров. С маской — через отдельный граф: у
            # маски свой вход, а её номер станет известен, когда соберутся все
            # клипы, поэтому пока стоит метка, её заменят в конце.
            pre_label = f"[{index}:v]"
            # Окну программы большой кадр ни к чему: уменьшаем ролик до
            # размера просмотра сразу, до масок и эффектов, — иначе они
            # считались бы на полном 1080p и просмотр не успевал.
            shrink = ""
            if preview and clip.kind in {"video", "image"}:
                factor = effects.preview_factor(clip, width, height)
                if factor < 0.9:
                    clip = effects.scaled_for_preview(clip, factor)
                    # Размер — числами, теми же, что у копии клипа: по ним
                    # считается маска, и разойтись им нельзя ни на пиксель.
                    shrink = f"scale={clip.source_width}:{clip.source_height}:flags=bilinear,"
            timing = effects.Timing(
                skip=max(0.0, at - clip.start), take=take, fps=fps, tag=f"k{index}"
            )
            if clip.kind in {"video", "image"} and effects.needs_graph(clip):
                shape = ""
                if effects.has_mask(clip) and clip.mask_image:
                    masks.append((clip.mask_image, max(0.0, at - clip.start)))
                    shape = f"@MASK{len(masks) - 1}@"
                chain.append(effects.clip_graph(
                    clip, pre_label + shrink, f"[pre{index}]", f"k{index}",
                    shape=shape, preview=preview, timing=timing,
                ))
                pre_label = f"[pre{index}]"
                pre_chain = ""
            else:
                pre_chain = shrink + effects.video_chain(clip, preview=preview, timing=timing)
            fill = effects.blurred_fill(clip) if clip.kind in {"video", "image"} else None
            if fill:
                # Размытый фон: под клипом он сам же, растянутый на всё своё
                # место и размытый, — вместо чёрных полос по бокам. Место — весь
                # кадр или прямоугольник переставленного клипа; клип ложится
                # посередине, и результат ровно размером с место.
                sigma, dim = fill
                box_w, box_h = clip_box(clip, width, height) if is_placed(clip) else (width, height)
                chain.append(
                    f"{pre_label}{pre_chain}split=2[fa{index}][fb{index}];"
                    f"[fa{index}]scale={box_w}:{box_h}:force_original_aspect_ratio=increase,"
                    f"crop={box_w}:{box_h},gblur=sigma={sigma:.1f},"
                    f"eq=brightness={-dim * 0.5:.3f}[fbg{index}];"
                    f"[fb{index}]scale={box_w}:{box_h}:force_original_aspect_ratio=decrease:flags=lanczos"
                    f"[ffg{index}];"
                    f"[fbg{index}][ffg{index}]overlay=(W-w)/2:(H-h)/2,"
                    f"format=yuva420p,setsar=1,fps={fps}{fades},"
                    f"setpts=PTS-STARTPTS+{offset:.3f}/TB[v{index}]"
                )
            else:
                # Эффекты — до вписывания в кадр: они работают с самим файлом.
                placement = (
                    animated_place_filter(clip, width, height, fps, max(0.0, at - clip.start))
                    if animated(clip)
                    else place_filter(clip, width, height, fps, max(0.0, at - clip.start))
                )
                chain.append(
                    f"{pre_label}{pre_chain}{placement}"
                    f"{fades},"
                    f"setpts=PTS-STARTPTS+{offset:.3f}/TB[v{index}]"
                )
            video_labels.append((f"[v{index}]", clip))

        # Звук берём и у роликов: иначе два видео подряд оказались бы немыми.
        # Только если он там действительно есть — ffmpeg на пустую дорожку
        # отвечает «Stream specifier ':a' matches no streams» и падает.
        if sound and not still:
            chain.append(
                f"[{index}:a]" + audio_filter(clip, at, offset, take) + f"[a{index}]"
            )
            audio_labels.append(f"[a{index}]")
        index += 1

    # Входы масок — после входов клипов. Картинка маски повторяется весь
    # отрезок: клип сам решает, сколько её взять.
    for number, (image, skip) in enumerate(masks):
        if image.endswith(".mkv"):
            # Маска-ролик: с того места клипа, с которого читается сам клип.
            inputs += ["-ss", f"{skip:.4f}", "-t", f"{span:.3f}", "-i", image]
        else:
            inputs += ["-loop", "1", "-t", f"{span:.3f}", "-i", image]
        chain = [part.replace(f"@MASK{number}@", f"[{index + number}:v]") for part in chain]

    # Слои снизу вверх. eof_action=pass — кончившийся клип просто перестаёт
    # показываться, а не обрывает всю картинку.
    layer = "[bg]"
    for number, (label, clip) in enumerate(video_labels):
        nxt = f"[s{number}]"
        # Переставленный клип ставим серединой туда, куда его поместили:
        # x и y — доли кадра, 0.5 это центр. Считаем от середины, а не от
        # свободного места, иначе клип крупнее кадра было бы некуда двигать.
        #
        # Место округляем до чётного пикселя — и край, и отступ картинки
        # внутри него. Цвет в готовом видео хранится на вдвое меньшей сетке,
        # поэтому ffmpeg всё равно сдвинет наложение на чётную позицию, но
        # сделает это молча и всегда вниз: у картинок с разной шириной
        # отступы получались разной чётности, и разложенные по сетке кадры
        # вставали вразнобой — тот самый съезд на пиксель. Считаем чётность
        # сами, тогда одинаковые клетки получают одинаковые позиции.
        place = ""
        if animated(clip) and not effects.blurred_fill(clip):
            # Время фона — от начала отрезка; ключи — от начала клипа.
            moment = f"(t+{at - clip.start:.4f})"
            place = (
                f":x='W*({anim.expression(clip, 'x', moment)})-w/2'"
                f":y='H*({anim.expression(clip, 'y', moment)})-h/2':eval=frame"
            )
        elif is_placed(clip):
            box_w, box_h = clip_box(clip, width, height)
            left = _even_pixels(f"W*{clip.x:.5f}-{box_w / 2:.3f}")
            top = _even_pixels(f"H*{clip.y:.5f}-{box_h / 2:.3f}")
            place = (
                f":x={left}+{_even_pixels(f'({box_w}-w)/2')}"
                f":y={top}+{_even_pixels(f'({box_h}-h)/2')}"
            )
        chain.append(f"{layer}{label}overlay=eof_action=pass:shortest=0{place}{nxt}")
        layer = nxt

    if audio_labels:
        mixed = (
            "".join(audio_labels)
            + f"amix=inputs={len(audio_labels)}:normalize=0:duration=longest"
        )
        # Громкость всего монтажа и выравнивание — уже после смешивания:
        # это про готовый файл целиком, а не про отдельные клипы. Порядок
        # тот же, что и при обычной обработке: громкость до выравнивания,
        # иначе loudnorm вернул бы её обратно и ползунок не делал бы ничего.
        if abs(project.master_volume - 1.0) > 1e-6:
            mixed += f",volume={project.master_volume:.3g}"
        if project.loudnorm:
            mixed += ",loudnorm=I=-16:TP=-1.5:LRA=11"
        chain.append(mixed + "[aout]")

    args = [binaries.ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]
    args += inputs
    args += ["-filter_complex", ";".join(chain), "-map", layer]

    if still:
        args += ["-frames:v", "1"]
        # Кадру окна просмотра хватает JPEG; снимок, который человек забирает
        # себе, сохраняем PNG — для этого сюда и передают кодек.
        args += codec or ["-q:v", "3"]
    else:
        if audio_labels:
            args += ["-map", "[aout]"]
        args += codec or DRAFT_CODEC
        if audio_labels and not any(part == "-c:a" for part in (codec or [])):
            # Черновик всегда в два канала: у моно-источника вторая полоска
            # шкалы уровня оставалась бы пустой, и человек решил бы, что
            # правый канал потерялся.
            args += ["-c:a", "aac", "-b:a", "128k", "-ac", "2"]
        # Длину задаём явно: фон её знает, но клипы могут оказаться короче.
        args += ["-t", f"{span:.3f}"]

    if progress:
        args += ["-progress", "pipe:1", "-nostats"]
    args.append(str(output))
    return args


def build_frame(project: ComposeProject, output: Path, at: float, width: int) -> list[str]:
    """Команда для одного кадра под иглой."""
    # Высота считается от кадра проекта, чтобы картинка не была растянутой.
    height = round(width * project.height / project.width)
    return build_segment(
        project, output, at=at, span=1.0 / max(project.fps, 1),
        width=width, height=height, still=True, preview=True,
    )


#: Картинки, которые ffmpeg читает «по одной» (image2): у них есть `-loop 1`.
_STILL_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}


def _repeat(source: str) -> list[str]:
    """Как повторять картинку весь клип.

    `-loop 1` есть только у чтения по одной картинке. AVIF и GIF ffmpeg
    открывает иначе — как ролик, — и на `-loop` отвечает «Option loop not
    found»: картинка не попадала ни в кадр, ни в сборку. Им нужен
    `-stream_loop -1` — повтор файла целиком; у движущегося GIF это заодно
    зацикливает анимацию. Проверено на avif, gif, webp, png и jpg.
    """
    if Path(source).suffix.lower() in _STILL_SUFFIXES:
        return ["-loop", "1"]
    return ["-stream_loop", "-1"]


async def prepare(
    project: ComposeProject,
    *,
    skip_missing: bool = False,
    lost: list[str] | None = None,
) -> ComposeProject:
    """Проверяет файлы монтажа и выясняет, у кого из них есть звук.

    Зовётся перед каждой сборкой. Проверка путей — та же, что у остальной
    программы: за пределы рабочих папок монтаж не выходит. Наличие звука
    нужно знать заранее — ffmpeg падает, если попросить дорожку, которой нет,
    а ответы ffprobe кэшируются, так что дважды один файл не читается.

    ``skip_missing`` — для просмотра: пропавший файл просто не рисуется, а
    остальной монтаж виден. Какие файлы пропущены, складывается в ``lost`` —
    окно по ним открывает список пропавших, даже если файл удалили прямо во
    время работы. Человек может отложить поиск файла и работать
    дальше; о пропаже ему уже сказало окно при открытии проекта. Готовый
    файл так не собирается: молча выкинуть кусок монтажа из результата нельзя.
    """
    missing: list[str] = []
    for track in project.tracks:
        kept = []
        for clip in track.clips:
            # Ключи, которые ничего не меняют, — обычные значения клипа.
            anim.settle(clip)
            # У сплошного фона и у надписи файла нет — и проверять нечего.
            if clip.kind in {"color", "text"}:
                clip.has_audio = False
                kept.append(clip)
                continue
            try:
                path = fsutil.safe_path(clip.source)
            except (PermissionError, FileNotFoundError, ValueError):
                missing.append(clip.source)
                continue
            clip.source = str(path)
            steady = effects.stabilizer(clip)
            if steady:
                # Для окна просмотра — что есть: копия готова — берём её, нет —
                # показываем исходник, а копия тем временем считается в фоне.
                # Готовому файлу ждать приходится: см. ``stabilize_all``.
                ready = stabilize.ready(str(path), steady)
                clip.stable_source = str(ready) if ready else ""
            # Размер файла нужен и маскам, и уменьшению для просмотра —
            # узнаём у всех роликов и картинок (ответ ffprobe в кэше).
            if clip.kind in {"video", "image"} and not clip.source_width:
                try:
                    info = await probe(path)
                    stream = info.video
                    if stream and stream.width and stream.height:
                        clip.source_width, clip.source_height = stream.width, stream.height
                except (RuntimeError, OSError):
                    pass
            if clip.kind == "video" and not clip.source_fps:
                try:
                    stream = (await probe(path)).video
                    clip.source_fps = (stream.fps or 0.0) if stream else 0.0
                except (RuntimeError, OSError):
                    pass
            if clip.kind == "image":
                clip.has_audio = False
            elif clip.has_audio is None:
                try:
                    clip.has_audio = (await probe(path)).has_audio
                except (RuntimeError, OSError):
                    clip.has_audio = False
            kept.append(clip)
        track.clips = kept

    if lost is not None:
        lost.extend(dict.fromkeys(missing))
    if missing and not skip_missing:
        # Полный путь, а не одно имя: по имени непонятно, где файл лежал и что
        # искать, а одинаковые имена бывают в разных папках.
        shown = sorted(set(missing))
        listed = "\n".join(shown[:5]) + (f"\n…и ещё {len(shown) - 5}" if len(shown) > 5 else "")
        raise FileNotFoundError(f"Файлы монтажа не найдены или лежат вне рабочих папок:\n{listed}")
    return project


async def stabilize_all(project: ComposeProject) -> None:
    """Дожидается ровных копий у всех стабилизированных роликов.

    Для готового файла и снимка кадра: собрать их по исходнику, пока копия
    ещё считается, значило бы молча выдать тряску, от которой просили
    избавиться.
    """
    for track in project.tracks:
        for clip in track.clips:
            steady = effects.stabilizer(clip)
            if steady and not clip.stable_source:
                clip.stable_source = str(await stabilize.wait(clip.source, steady))


def check_sources(sources: list[str]) -> dict[str, list[str]]:
    """Какие файлы монтажа пропали, а какие лежат вне рабочих папок.

    Пропавшие человек ищет сам — окно при открытии проекта. Найденные вне
    рабочих папок программа добавляет в них сама: файл на месте, и отбивать
    его ошибкой незачем (так же, как при перетаскивании на таймлайн).
    """
    missing: list[str] = []
    outside: list[str] = []
    for source in dict.fromkeys(sources):
        try:
            fsutil.safe_path(source)
        except PermissionError:
            if Path(source).is_file():
                outside.append(source)
            else:
                missing.append(source)
        except (FileNotFoundError, ValueError):
            missing.append(source)
    return {"missing": missing, "outside": outside}


def find_near(folder: str, sources: list[str]) -> dict[str, str]:
    """Ищет пропавшие файлы по имени в папке, где нашёлся один из них.

    Файлы проекта обычно переезжают вместе, и если один нашёлся в новой папке,
    остальные, скорее всего, лежат там же. Смотрим только саму папку: обход
    вглубь на большом диске занял бы секунды, а угадывал бы редко.
    """
    base = Path(folder)
    found: dict[str, str] = {}
    for source in sources:
        candidate = base / Path(source.replace("\\", "/")).name
        if candidate.is_file():
            found[source] = str(candidate)
    return found
