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

from pathlib import Path

from ..models import ComposeClip, ComposeProject
from . import binaries, fsutil
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
    """Что берём от клипа в этом окне: откуда читать, сколько и когда показать."""
    # Сколько клипа уже прошло к началу окна.
    skip = max(0.0, at - clip.start)
    seek = clip.source_in + skip
    offset = max(0.0, clip.start - at)
    take = min(clip.duration - skip, span - offset)
    return seek, max(take, 0.0), offset


def fit_filter(width: int, height: int, fps: int) -> str:
    """Вписать чужой кадр в кадр проекта, добив поля чёрным.

    Именно вписать, а не обрезать: человек положил на дорожку свой файл и не
    ожидает, что программа отрежет ему полкадра. Вертикальное видео в
    горизонтальном проекте получит чёрные поля по бокам — так же, как это
    делают монтажные программы.
    """
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,"
        f"pad={width}:{height}:-1:-1:color=black,setsar=1,fps={fps}"
    )


def _even(value: int) -> int:
    """Кодировщики не берут нечётные размеры кадра."""
    return max(2, value - value % 2)


def zoom_filter(clip: ComposeClip, width: int, height: int) -> str:
    """Приближение внутри кадра: увеличиваем и обрезаем по краям."""
    if clip.zoom <= 1.0:
        return ""
    big_w = max(2, int(width * clip.zoom) // 2 * 2)
    big_h = max(2, int(height * clip.zoom) // 2 * 2)
    return f",scale={big_w}:{big_h}:flags=lanczos,crop={width}:{height}"


def is_placed(clip: ComposeClip) -> bool:
    """Двигали ли клип по кадру или меняли его размер."""
    return (
        abs(clip.size - 1.0) > 1e-6
        or abs(clip.x - 0.5) > 1e-6
        or abs(clip.y - 0.5) > 1e-6
    )


def place_filter(clip: ComposeClip, width: int, height: int, fps: int) -> str:
    """Во весь кадр или своим размером в своём месте.

    Нетронутый клип вписывается в кадр как обычно — с чёрными полями, если
    форма не совпала. Переставленному или изменённому поля не нужны и вредны:
    чёрная рамка вокруг накрыла бы то, что лежит под ним, а ради этого
    «картинку в картинке» и делают. Размер считается от кадра: 0.5 — вчетверо
    меньше, 2 — вдвое крупнее кадра, лишнее уйдёт за края.

    Приближение у переставленного клипа отрезает края у **исходника**, до
    подгонки размера, — иначе картинку растянуло бы.
    """
    if not is_placed(clip):
        return fit_filter(width, height, fps) + zoom_filter(clip, width, height)

    box_w = _even(max(2, int(width * clip.size)))
    box_h = _even(max(2, int(height * clip.size)))
    parts: list[str] = []
    if clip.zoom > 1.0:
        parts.append(f"crop=iw/{clip.zoom:.3f}:ih/{clip.zoom:.3f}")
    parts.append(
        f"scale={box_w}:{box_h}:force_original_aspect_ratio=decrease:flags=lanczos"
    )
    parts.append("setsar=1")
    parts.append(f"fps={fps}")
    return ",".join(parts)


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
) -> list[str]:
    """Команда ffmpeg для отрезка монтажа.

    ``still`` — нужен один кадр (окно просмотра), ``codec`` — чем кодировать;
    без него берётся быстрый черновой H.264. ``progress`` просит ffmpeg
    рассказывать, сколько уже сделано: без этого полоса готовности у задачи
    так и стоит на нуле до самого конца. Кадру и черновику он не нужен — их
    никто не ждёт с полосой.
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

        if clip.kind == "color":
            # Сплошной фон рисует сам ffmpeg — файла у такого клипа нет.
            inputs += [
                "-f", "lavfi", "-t", f"{take:.3f}",
                "-i", f"color=c={clip.color}:s={width}x{height}:r={fps}",
            ]
        elif clip.kind == "image":
            # Картинка — один кадр; без -loop она исчезнет сразу же.
            inputs += ["-loop", "1", "-t", f"{take:.3f}", "-i", clip.source]
        else:
            inputs += ["-ss", f"{seek:.3f}", "-t", f"{take:.3f}", "-i", clip.source]

        if clip.kind != "audio":
            chain.append(
                f"[{index}:v]{place_filter(clip, width, height, fps)}"
                f"{video_fades(clip, at, take, moment=at if still else None)},"
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

    # Слои снизу вверх. eof_action=pass — кончившийся клип просто перестаёт
    # показываться, а не обрывает всю картинку.
    layer = "[bg]"
    for number, (label, clip) in enumerate(video_labels):
        nxt = f"[s{number}]"
        # Переставленный клип ставим серединой туда, куда его поместили:
        # x и y — доли кадра, 0.5 это центр. Считаем от середины, а не от
        # свободного места, иначе клип крупнее кадра было бы некуда двигать.
        place = ""
        if is_placed(clip):
            place = f":x=W*{clip.x:.5f}-w/2:y=H*{clip.y:.5f}-h/2"
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
        width=width, height=height, still=True,
    )


async def prepare(project: ComposeProject) -> ComposeProject:
    """Проверяет файлы монтажа и выясняет, у кого из них есть звук.

    Зовётся перед каждой сборкой. Проверка путей — та же, что у остальной
    программы: за пределы рабочих папок монтаж не выходит. Наличие звука
    нужно знать заранее — ffmpeg падает, если попросить дорожку, которой нет,
    а ответы ffprobe кэшируются, так что дважды один файл не читается.
    """
    missing: list[str] = []
    for track in project.tracks:
        for clip in track.clips:
            # У сплошного фона файла нет — и проверять нечего.
            if clip.kind == "color":
                clip.has_audio = False
                continue
            try:
                path = fsutil.safe_path(clip.source)
            except (PermissionError, FileNotFoundError, ValueError):
                missing.append(Path(clip.source).name)
                continue
            clip.source = str(path)
            if clip.kind == "image":
                clip.has_audio = False
            elif clip.has_audio is None:
                try:
                    clip.has_audio = (await probe(path)).has_audio
                except (RuntimeError, OSError):
                    clip.has_audio = False

    if missing:
        names = ", ".join(sorted(set(missing))[:5])
        raise FileNotFoundError(
            f"Файлы монтажа не найдены или лежат вне рабочих папок: {names}"
        )
    return project
