"""Сборка командных строк ffmpeg для видео и аудио.

Здесь нет запуска процессов — только чистая логика построения аргументов,
чтобы её можно было спокойно тестировать и показывать пользователю
(в интерфейсе есть кнопка «показать команду ffmpeg»).
"""

from __future__ import annotations

import shlex
from pathlib import Path
from typing import Any

from ..models import AudioOptions, ExportRequest, Trim, VideoOptions
from .probe import BITMAP_SUBTITLES, MediaInfo
from . import fades

#: Расширения контейнеров по кодекам, когда пользователь выбрал «auto».
_AUDIO_EXT = {
    "opus": ".opus",
    "aac": ".m4a",
    "mp3": ".mp3",
    "flac": ".flac",
}


def _fmt_time(value: float) -> str:
    """Секунды -> строка с миллисекундной точностью для -ss/-t."""
    return f"{max(value, 0.0):.3f}"


def clip_duration(trim: Trim, info: MediaInfo | None) -> float | None:
    """Сколько длится то, что получится после обрезки.

    Считается от обеих меток сразу. Раньше случай «поставлена только метка
    Out» брал длину всего файла: у ролика на час с меткой Out на минуте
    затухание вставало на 59-й минуте — то есть за концом результата, и его
    просто не было. Молча: ни ошибки, ни предупреждения.
    """
    total = info.duration if info else None
    start = trim.start or 0.0
    end = trim.end if trim.end is not None else total
    if end is None:
        return None
    return max(end - start, 0.0)


def build_video_filters(
    options: VideoOptions,
    info: MediaInfo | None,
    duration: float | None = None,
) -> list[str]:
    """Цепочка видеофильтров: даунскейл, ограничение fps, темп, затухания."""
    filters: list[str] = []

    if options.tempo and abs(options.tempo - 1.0) > 1e-6:
        # setpts делит длительность кадров: PTS/1.06 = ускорение на 6%.
        filters.append(f"setpts=PTS/{options.tempo:.6g}")

    if options.max_height > 0:
        source_height = info.video.height if info and info.video else None
        if source_height is None or source_height > options.max_height:
            # min(target, ih) гарантирует, что маленькое видео не растянется вверх.
            filters.append(
                "scale=-2:" + f"'min({options.max_height},ih)'" + ":flags=lanczos"
            )

    scaled = any(item.startswith("scale=") for item in filters)
    if not scaled and info and info.video and (info.video.width % 2 or info.video.height % 2):
        # Цвет в видео живёт на вдвое меньшей сетке, и кодировщик отказывается
        # от кадра с нечётной стороной. У роликов так почти не бывает, а у
        # GIF, которые перегоняют в видео, — сплошь и рядом.
        filters.append("scale=trunc(iw/2)*2:trunc(ih/2)*2")

    if info and info.hdr:
        # Уменьшаем раньше перевода: переводить 4K вчетверо дольше.
        filters.append(TONEMAP)

    if options.max_fps > 0:
        source_fps = info.video.fps if info and info.video else None
        # Темп уже умножает фактический fps, учитываем это при сравнении.
        effective = (source_fps or 0) * (options.tempo or 1.0)
        if not source_fps or effective > options.max_fps + 0.01:
            filters.append(f"fps={options.max_fps}")

    # Затухания ставим последними: они должны работать по итоговому времени,
    # уже с учётом изменённого темпа.
    if fades.custom(options.fade_in_curve) or fades.custom(options.fade_out_curve):
        filters.append(_shaped_fades(options, duration))
        return filters
    if options.fade_in > 0:
        filters.append(f"fade=t=in:st=0:d={options.fade_in:g}")
    if options.fade_out > 0 and duration and duration > options.fade_out:
        start = max(duration - options.fade_out, 0.0)
        filters.append(f"fade=t=out:st={start:.3f}:d={options.fade_out:g}")

    return filters


#: Перевод HDR в обычное видео (BT.709). Без него цифры кадра остаются
#: прежними, а значат другое: картинка выходит серой и бледной, а пометка
#: «HDR» в файле заставляет плееры гадать. Подобрано по тому, как серию
#: показывает обычный плеер: ``hable`` с белым на 100 нит. Первый выбор —
#: ``mobius`` с белым на 203 нит, ближайший к libplacebo, — приподнимал тени,
#: и картинка выходила выцветшей.
TONEMAP = (
    "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
    "tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
)

#: Пометки обычного цвета для файла, переведённого из HDR.
SDR_TAGS = [
    "-colorspace", "bt709", "-color_primaries", "bt709",
    "-color_trc", "bt709", "-color_range", "tv",
]


def normal_rate(sample_rate: int | None) -> int:
    """Обычная частота звука: как у исходника, если она из привычных, иначе 48 кГц."""
    return sample_rate if sample_rate in {44100, 48000} else 48000


def build_audio_filters(
    options: AudioOptions,
    *,
    tempo: float = 1.0,
    duration: float | None = None,
    sample_rate: int | None = None,
) -> list[str]:
    """Цепочка аудиофильтров: темп, нормализация громкости, фейды.

    ``sample_rate`` — частота звука исходника: к ней звук возвращается после
    выравнивания громкости.
    """
    filters: list[str] = []

    if tempo and abs(tempo - 1.0) > 1e-6:
        # atempo принимает 0.5-2.0 за проход; для крайних значений цепляем каскад.
        remaining = tempo
        while remaining > 2.0:
            filters.append("atempo=2.0")
            remaining /= 2.0
        while remaining < 0.5:
            filters.append("atempo=0.5")
            remaining /= 0.5
        if abs(remaining - 1.0) > 1e-6:
            filters.append(f"atempo={remaining:.6g}")

    # Громкость двигаем до выравнивания: иначе loudnorm вернул бы её обратно,
    # и ползунок не делал бы ничего.
    if abs(options.volume - 1.0) > 1e-6:
        filters.append(f"volume={options.volume:.3g}")

    if options.loudnorm:
        params = [
            f"I={options.loudnorm_i:g}",
            f"TP={options.loudnorm_tp:g}",
            f"LRA={options.loudnorm_lra:g}",
        ]
        filters.append("loudnorm=" + ":".join(params))
        # loudnorm работает и отдаёт звук на 192 кГц. Opus всё равно пишет 48,
        # а AAC брал самое большое, что умеет, — 96 кГц, и монтажные
        # программы такой файл читали неверно: звук повторялся и не сходился
        # с картинкой по длине. Возвращаем частоту исходника.
        filters.append(f"aresample={normal_rate(sample_rate)}")

    # curve=qsin — четверть синусоиды: громкость по ней уходит равномерно на
    # слух, а не «проваливается» в конце, как при линейном затухании. Именно
    # такую кривую по умолчанию рисуют монтажные программы.
    if options.fade_in > 0:
        filters.append(
            f"afade=t=in:curve={fades.afade_curve(options.fade_in_curve, 'in')}:st=0:d={options.fade_in:g}"
        )

    if options.fade_out > 0 and duration and duration > options.fade_out:
        start = max(duration - options.fade_out, 0.0)
        filters.append(
            f"afade=t=out:curve={fades.afade_curve(options.fade_out_curve, 'out')}"
            f":st={start:.3f}:d={options.fade_out:g}"
        )

    if options.codec == "opus" and not options.mono and not options.stereo:
        # Opus знает только свои раскладки каналов: 5.1 с боковыми
        # колонками («5.1(side)», так у фильмов с E-AC-3) он не принимает, и
        # сборка падала. Приводим к ближайшей знакомой — каналов столько же.
        filters.append("aformat=channel_layouts=" + "|".join(_OPUS_LAYOUTS))

    return filters


#: Раскладки каналов, которые принимает Opus.
_OPUS_LAYOUTS = ["mono", "stereo", "3.0", "quad", "5.0", "5.1", "6.1", "7.1"]


#: Поправка к CRF в зависимости от итоговой высоты кадра.
#:
#: Одно и то же число CRF на разных разрешениях выглядит по-разному: на мелком
#: кадре артефакты заметнее, потому что зритель видит его растянутым на весь
#: экран. Пресет задаёт качество «как на 720p», а здесь мы приводим его
#: к реальному разрешению — иначе 360p-исходник, сжатый «пресетом 720p»,
#: получался бы неоправданно грязным.
_CRF_BY_HEIGHT: list[tuple[int, int]] = [
    (2160, +7),
    (1440, +5),
    (1080, +3),
    (720, 0),
    (540, -3),
    (360, -5),
    (0, -7),
]


def target_height(options: VideoOptions, info: MediaInfo | None) -> int | None:
    """Какая высота кадра получится на выходе. None, если определить нельзя."""
    source = info.video.height if info and info.video else None
    if options.max_height > 0:
        return min(options.max_height, source) if source else options.max_height
    return source


#: Скорость процессорных кодировщиков — в пресет видеокарты (p7 — медленно и
#: качественно, p1 — быстро). Иначе на видеокарте выбранная скорость молча
#: превращалась в средний p5.
_GPU_BY_NAME = {
    "veryslow": "p7", "slower": "p7", "slow": "p6", "medium": "p5",
    "fast": "p4", "faster": "p3", "veryfast": "p2", "superfast": "p1", "ultrafast": "p1",
}


def _gpu_preset(speed: str) -> str:
    """Пресет скорости для NVENC: p1 — быстро, p7 — качественно."""
    if not isinstance(speed, str):
        return "p5"
    if speed.startswith("p"):
        return speed
    if speed in _GPU_BY_NAME:
        return _GPU_BY_NAME[speed]
    if speed.isdigit():
        # Скорость SVT-AV1: меньше — медленнее и качественнее.
        level = int(speed)
        return "p7" if level <= 2 else "p6" if level <= 4 else "p5" if level <= 6 else "p3" if level <= 8 else "p2"
    return "p5"


def resolve_codec(options: VideoOptions) -> str:
    """Кодек с учётом галочки «на видеокарте».

    Если ускорять нечем, молча остаёмся на процессоре: лучше кодировать
    медленнее, чем уронить задачу непонятной ошибкой.
    """
    from . import binaries

    if not options.use_gpu or options.codec == "copy":
        return options.codec
    if options.codec.endswith(("nvenc", "qsv", "amf")):
        return options.codec

    chosen = binaries.hardware_codec(options.codec) or options.codec
    # Режим без потерь из видеокарт умеет только NVIDIA. У остальных ноль
    # превратился бы в обычное сжатие — молча и незаметно, поэтому для них
    # остаёмся на процессоре.
    if options.crf == 0 and not chosen.endswith("nvenc"):
        return options.codec
    return chosen


def gpu_quality(codec: str, crf: int) -> int:
    """Переводит CRF в шкалу аппаратного кодировщика.

    У NVENC своя шкала, и то же число даёт совсем другой вес файла. Смещение
    подобрано замером на реальном ролике: для сжатия важнее предсказуемый
    размер, чем последние проценты качества. Совсем сравнять не получится —
    видеокарта при равном весе всегда рисует чуть хуже процессора.
    """
    if codec.startswith("av1"):
        return max(15, min(51, crf + 4))
    return max(15, min(51, crf + 2))


def effective_crf(options: VideoOptions, info: MediaInfo | None) -> int:
    """CRF пресета, подогнанный под фактическое разрешение."""
    if options.crf == 0:
        return 0

    adjusted = options.crf
    height = target_height(options, info)
    if options.adapt_crf and height:
        offset = next(delta for threshold, delta in _CRF_BY_HEIGHT if height >= threshold)
        adjusted = max(0, min(63, options.crf + offset))

    # У аппаратных кодировщиков своя шкала — переводим в неё.
    codec = resolve_codec(options)
    if codec.endswith(("nvenc", "qsv", "amf")):
        return gpu_quality(codec, adjusted)
    return adjusted


def video_codec_args(options: VideoOptions, crf: int | None = None) -> list[str]:
    """Аргументы кодека видео. ``crf`` перебивает значение из пресета."""
    codec = resolve_codec(options)
    if codec == "copy":
        return ["-c:v", "copy"]

    quality = options.crf if crf is None else crf
    rate = options.bitrate_kbps

    def by_quality(flag: str = "-crf") -> list[str]:
        """Чем задаём вес: качеством или битрейтом.

        Качество — обычный случай: кодировщик сам решает, сколько потратить на
        каждый кадр. Битрейт нужен, когда важен предсказуемый вес файла; тогда
        сжатие идёт одним проходом с ограничением пика — двухпроходное здесь
        не окупается, а времени занимает вдвое.
        """
        if rate <= 0:
            return [flag, str(quality)]
        return [
            "-b:v", f"{rate}k",
            "-maxrate", f"{int(rate * 1.5)}k",
            "-bufsize", f"{rate * 2}k",
        ]

    if codec == "av1_svt":
        return [
            "-c:v", "libsvtav1",
            # Предел пика SVT-AV1 принимает только в режиме качества («Max
            # Bitrate only supported with CRF mode») — с битрейтом даём одно
            # среднее, кодировщик держит его сам.
            *(by_quality() if rate <= 0 else ["-b:v", f"{rate}k"]),
            "-preset", str(options.speed_preset),
            # tune=0 оптимизирует под субъективное восприятие, а не под PSNR.
            "-svtav1-params", "tune=0",
            "-pix_fmt", "yuv420p",
        ]

    if codec == "av1_nvenc":
        return [
            "-c:v", "av1_nvenc",
            # Пресеты SVT («6») NVENC не понимает — у него своя шкала p1..p7.
            "-preset", _gpu_preset(options.speed_preset),
            "-rc", "vbr",
            *(["-cq", str(quality), "-b:v", "0"] if rate <= 0 else ["-b:v", f"{rate}k"]),
            "-pix_fmt", "yuv420p",
        ]

    if codec in {"av1_qsv", "h264_qsv"}:
        return [
            "-c:v", codec,
            "-global_quality", str(quality),
            "-preset", "medium",
            "-pix_fmt", "yuv420p",
        ]

    if codec in {"av1_amf", "h264_amf"}:
        return [
            "-c:v", codec,
            "-quality", "balanced",
            "-qp_i", str(quality),
            "-qp_p", str(quality),
            "-pix_fmt", "yuv420p",
        ]

    if codec == "h264":
        return [
            "-c:v", "libx264",
            *by_quality(),
            "-preset", str(options.speed_preset or "fast"),
            # Профиль указываем только для сжатия с потерями: в режиме без
            # потерь x264 с ним просто не запускается.
            *([] if quality == 0 and rate <= 0 else ["-profile:v", "high"]),
            "-pix_fmt", "yuv420p",
        ]

    if codec == "h264_nvenc":
        # Ноль означает «без потерь». У видеокарты это отдельный режим, а не
        # значение качества: с обычным -cq 0 она отдала бы просто очень
        # хороший, но всё же сжатый файл.
        if quality == 0:
            return [
                "-c:v", "h264_nvenc",
                "-tune", "lossless",
                "-pix_fmt", "yuv420p",
            ]
        return [
            "-c:v", "h264_nvenc",
            "-preset", _gpu_preset(options.speed_preset),
            "-rc", "vbr",
            *(["-cq", str(quality), "-b:v", "0"] if rate <= 0 else ["-b:v", f"{rate}k"]),
            "-pix_fmt", "yuv420p",
        ]

    if codec == "h265":
        return [
            "-c:v", "libx265",
            *by_quality(),
            "-preset", str(options.speed_preset or "medium"),
            # hvc1 нужен, чтобы файл открывался в плеерах Apple.
            "-tag:v", "hvc1",
            "-pix_fmt", "yuv420p",
        ]

    raise ValueError(f"Неизвестный видеокодек: {codec}")


def audio_extension(codec: str) -> str:
    """Расширение звукового файла для кодека — без точки."""
    return _AUDIO_EXT.get(codec, ".m4a").lstrip(".")


def audio_codec_args(options: AudioOptions) -> list[str]:
    """Аргументы кодека звука."""
    codec = options.codec
    if codec == "none":
        return ["-an"]
    if codec == "copy":
        return ["-c:a", "copy"]

    args: list[str]
    if codec == "opus":
        args = [
            "-c:a", "libopus",
            "-b:a", f"{options.bitrate_kbps}k",
            # Без этого Opus принимает только моно и стерео.
            "-mapping_family", "1",
            "-vbr", "on",
            "-application", "audio",
        ]
    elif codec == "aac":
        args = ["-c:a", "aac", "-b:a", f"{options.bitrate_kbps}k"]
    elif codec == "mp3":
        args = ["-c:a", "libmp3lame", "-b:a", f"{options.bitrate_kbps}k"]
        # Больше двух каналов MP3 не держит: звук 5.1 сводим в стерео, иначе
        # кодировщик отказывается.
        if not options.mono:
            args += ["-ac", "2"]
    elif codec == "flac":
        args = ["-c:a", "flac"]
    else:
        raise ValueError(f"Неизвестный аудиокодек: {codec}")

    if options.mono:
        args += ["-ac", "1"]
    elif options.stereo:
        args += ["-ac", "2"]
    return args


def container_extension(request: ExportRequest, info: MediaInfo | None) -> str:
    """Расширение выходного файла."""
    if request.kind == "audio" or request.video.strip_video:
        if request.audio.codec == "copy":
            return Path(request.source).suffix or ".m4a"
        return _AUDIO_EXT.get(request.audio.codec, ".m4a")

    container = request.video.container
    if container == "auto":
        # Opus официально живёт в MP4, но WebM для него — родной дом.
        if request.video.codec.startswith("av1") and request.audio.codec == "opus":
            return ".webm"
        return ".mp4"
    return f".{container}"


def _same_track(streams: list, number: int, language: str | None, title: str | None) -> int:
    """Дорожка с тем же языком и названием, что выбрали в открытом файле.

    Пачка серий обрабатывается с выбором, сделанным в одной из них, а
    дорожки в разных файлах бывают в разном порядке: по номеру у остальных
    бралась бы чужая озвучка. Не нашлась такая — остаётся номер.
    """
    if not language:
        return number
    same = [i for i, s in enumerate(streams) if (s.language or "und") == language]
    if title:
        named = [i for i in same if (streams[i].title or "") == title]
        same = named or same
    if number in same or not same:
        return number
    return same[0]


def chosen_audio(request: ExportRequest, info: MediaInfo | None) -> list[int]:
    """Номера звуковых дорожек, которые берём, — среди звуковых, по порядку."""
    single = request.audio.track
    if info and not request.audio.tracks:
        single = _same_track(
            info.audio_tracks, single, request.audio.track_language, request.audio.track_title
        )
    wanted = request.audio.tracks or [single]
    total = len(info.audio_tracks) if info else None
    # -1 — «все, сколько есть»: так пачка файлов просит все дорожки, не зная,
    # сколько их у каждого.
    if -1 in wanted and total is not None:
        wanted = list(range(total))
    picked: list[int] = []
    for number in wanted:
        if number < 0 or (total is not None and number >= total) or number in picked:
            continue
        picked.append(number)
    # Ничего подходящего (файл без звука или номер устарел) — первая, если есть.
    if not picked and (total is None or total > 0):
        picked = [0]
    return picked


def chosen_subtitles(request: ExportRequest, info: MediaInfo | None) -> list[int]:
    """Номера дорожек субтитров, которые попросили, — только существующие."""
    total = len(info.subtitle_tracks) if info else 0
    if -1 in request.subtitles.tracks:
        return list(range(total))
    wanted = request.subtitles.tracks
    if info and len(wanted) == 1:
        wanted = [_same_track(info.subtitle_tracks, wanted[0], request.subtitles.language, request.subtitles.title)]
    return sorted({n for n in wanted if 0 <= n < total})


#: Чем писать субтитры внутри видео, по контейнеру. ``None`` — как есть.
_SUBTITLE_CODEC = {".mp4": "mov_text", ".mov": "mov_text", ".webm": "webvtt", ".mkv": None}

#: Отдельный файл субтитров: (расширение, кодек), ``None`` — без перекодирования.
_SUBTITLE_FILE = {
    "subrip": (".srt", None),
    "srt": (".srt", None),
    "mov_text": (".srt", "srt"),
    "text": (".srt", "srt"),
    "ass": (".ass", None),
    "ssa": (".ass", None),
    "webvtt": (".vtt", None),
    "hdmv_pgs_subtitle": (".sup", None),
}


def subtitles_only(request: ExportRequest) -> bool:
    """Нужны одни субтитры: видео осталось бы прежним, и копия его ни к чему.

    Так бывает, когда субтитры достают пресетом «Без сжатия»: без отрезка
    картинка и звук копируются как есть, и рядом появилась бы вторая такая же
    серия.
    """
    return (
        request.subtitles.extract
        and bool(request.subtitles.tracks)
        and request.stream_copy
        and not request.trim.is_set
    )


def subtitle_outputs(
    request: ExportRequest, info: MediaInfo | None, stem: Path
) -> list[tuple[int, Path, str | None]]:
    """Отдельные файлы субтитров: номер дорожки, путь и кодек.

    Имя — как у видео плюс язык: «Серия.rus.srt». Так плееры сами находят
    субтитры рядом с роликом. Язык повторяется — добавляем номер дорожки.
    """
    tracks = info.subtitle_tracks if info else []
    chosen = chosen_subtitles(request, info)
    languages = [tracks[n].language or "und" for n in chosen]
    result: list[tuple[int, Path, str | None]] = []
    for number in chosen:
        stream = tracks[number]
        extension, codec = _SUBTITLE_FILE.get(stream.codec or "", (".mks", None))
        language = stream.language or "und"
        label = f"{number + 1}.{language}" if languages.count(language) > 1 else language
        result.append((number, stem.with_name(f"{stem.name}.{label}{extension}"), codec))
    return result


def subtitle_command(
    request: ExportRequest, info: MediaInfo | None, outputs: list[tuple[int, Path, str | None]]
) -> list[str]:
    """Одна команда, которая пишет все отдельные файлы субтитров разом."""
    from . import binaries

    args = [binaries.ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]
    args += input_args(request.trim, request.source, accurate=True)
    for number, path, codec in outputs:
        args += ["-map", f"0:s:{number}", "-c:s", codec or "copy"]
        if path.suffix == ".mks":
            args += ["-f", "matroska"]
        args.append(str(path))
    return args


def input_args(trim: Trim, source: str, *, accurate: bool) -> list[str]:
    """Аргументы ввода с учётом обрезки.

    ``-ss`` до ``-i`` работает быстро (перемотка по индексу контейнера) и при
    перекодировании остаётся точным: ffmpeg декодирует от ближайшего ключевого
    кадра и отбрасывает лишнее. При ``-c copy`` точность ограничена ключевыми
    кадрами — об этом пользователь предупреждён в интерфейсе.
    """
    args: list[str] = []
    if trim.start:
        args += ["-ss", _fmt_time(trim.start)]

    duration = trim.duration
    if duration is None and trim.end is not None:
        duration = trim.end
    if duration is not None:
        # -t перед -i ограничивает объём читаемого исходника. Это важно при
        # изменении темпа: иначе лимит применился бы к уже ускоренному выходу
        # и хвост фрагмента потерялся бы.
        args += ["-t", _fmt_time(duration)]

    args += ["-i", source]

    if not accurate:
        # Иначе первый кадр среза может получить отрицательную метку времени.
        args += ["-avoid_negative_ts", "make_zero"]
    return args


def build_command(
    request: ExportRequest,
    output: Path,
    info: MediaInfo | None,
    *,
    crf: int | None = None,
) -> list[str]:
    """Полная команда ffmpeg для одного задания экспорта."""
    from . import binaries

    audio_only = request.kind == "audio" or request.video.strip_video
    stream_copy = request.stream_copy or (
        request.video.codec == "copy" and request.audio.codec == "copy"
    )

    args = [
        binaries.ffmpeg(),
        "-hide_banner",
        "-nostdin",
        "-loglevel", "error",
        "-y",
    ]
    args += input_args(request.trim, request.source, accurate=not stream_copy)

    # Нулевая громкость — это «без звука»: дорожку не берём вовсе. Записывать
    # тишину незачем, она занимает место и выглядит в других программах как
    # рабочий звук, который почему-то не слышно.
    muted = not audio_only and request.audio.volume <= 0

    # Дорожки выбирает человек, если их в файле несколько: у аниме это
    # обычно оригинал и озвучка, и первая — не всегда нужная.
    tracks = chosen_audio(request, info)
    has_audio = (info.has_audio if info else True) and not muted and bool(tracks)
    duration = clip_duration(request.trim, info)

    audio_filters: list[str] = []
    if has_audio and not stream_copy and request.audio.codec not in {"copy", "none"}:
        streams = info.audio_tracks if info else []
        first = streams[tracks[0]] if tracks and tracks[0] < len(streams) else None
        audio_filters = build_audio_filters(
            request.audio,
            tempo=1.0 if audio_only else request.video.tempo,
            duration=duration,
            sample_rate=first.sample_rate if first else None,
        )

    if not audio_only:
        args += ["-map", "0:v:0"]
    else:
        args += ["-vn"]
    if has_audio:
        for number in tracks:
            args += ["-map", f"0:a:{number}?"]

    # Субтитры внутрь видео. Картинками (PGS) их можно положить только в MKV.
    extension = output.suffix.lower()
    subtitle_codec = _SUBTITLE_CODEC.get(extension, "mov_text")
    embedded: list[int] = []
    if request.subtitles.embed and not audio_only:
        streams = info.subtitle_tracks if info else []
        for number in chosen_subtitles(request, info):
            if (streams[number].codec or "") in BITMAP_SUBTITLES and subtitle_codec:
                continue
            args += ["-map", f"0:s:{number}"]
            embedded.append(number)

    if stream_copy:
        args += ["-c", "copy"]
        if not has_audio:
            args += ["-an"]
    else:
        if not audio_only:
            args += video_codec_args(
                request.video, crf if crf is not None else effective_crf(request.video, info)
            )
            # Длительность результата с поправкой на темп — по ней ставится затухание.
            tempo = request.video.tempo or 1.0
            visible = (duration / tempo) if duration else None
            video_filters = build_video_filters(request.video, info, visible)
            if video_filters:
                args += ["-vf", ",".join(video_filters)]
            if info and info.hdr and request.video.codec != "copy":
                args += SDR_TAGS

        if has_audio:
            args += audio_codec_args(request.audio)
            if audio_filters:
                args += ["-af", ",".join(audio_filters)]
        else:
            args += ["-an"]

    if embedded:
        args += ["-c:s", subtitle_codec or "copy"]
    else:
        args += ["-sn"]

    suffix = output.suffix.lower()
    if suffix in {".mp4", ".m4a", ".mov"} and request.video.faststart:
        args += ["-movflags", "+faststart"]
    if suffix == ".mp4" and request.audio.codec == "opus" and not stream_copy:
        # Opus в MP4 официально разрешён, но ffmpeg просит явного согласия.
        args += ["-strict", "-2"]

    # Прогресс машиночитаемым потоком в stdout — его парсит планировщик задач.
    args += ["-progress", "pipe:1", "-nostats", str(output)]
    return args


def to_display_string(args: list[str]) -> str:
    """Команда в виде строки — для показа в интерфейсе и в логах."""
    return " ".join(shlex.quote(part) for part in args)


def describe(request: ExportRequest) -> dict[str, Any]:
    """Краткое человекочитаемое описание того, что произойдёт с файлом."""
    if request.kind == "image":
        image = request.image
        parts = [image.format.upper(), f"качество {image.quality}"]
        if image.max_dimension:
            parts.append(f"до {image.max_dimension}px")
        return {"summary": " · ".join(parts)}

    if request.stream_copy:
        return {"summary": "Копирование потока без перекодирования"}

    if request.kind == "audio" or request.video.strip_video:
        parts = [request.audio.codec.upper(), f"{request.audio.bitrate_kbps} кбит/с"]
        if request.audio.loudnorm:
            parts.append("нормализация")
        return {"summary": " · ".join(parts)}

    parts = [resolve_codec(request.video).replace("_", " ").upper(), f"CRF {request.video.crf}"]
    if request.video.max_height:
        parts.append(f"{request.video.max_height}p")
    if request.video.max_fps:
        parts.append(f"{request.video.max_fps} к/с")
    if abs(request.video.tempo - 1.0) > 1e-6:
        parts.append(f"×{request.video.tempo:g}")
    parts.append(f"{request.audio.codec.upper()} {request.audio.bitrate_kbps}k")
    return {"summary": " · ".join(parts)}


def _shaped_fades(options: VideoOptions, duration: float | None) -> str:
    """Появление и уход из чёрного с формой (`core/fades.py`).

    `fade` умеет только прямую линию, поэтому силу кадра считает формула
    `geq` — и только на кадрах появления и ухода (`enable`), остальные
    проходят мимо. Чёрный — 16, середина цвета — 128: файл всё равно
    сохраняется в 8-битном yuv420p.
    """
    gain = ["1"]
    when: list[str] = []
    if options.fade_in > 0:
        share = f"T/{options.fade_in:g}"
        gain.append(f"if(lt(T,{options.fade_in:g}),{fades.expression(options.fade_in_curve or 'linear', share)},1)")
        when.append(f"lt(t,{options.fade_in:g})")
    if options.fade_out > 0 and duration and duration > options.fade_out:
        start = max(duration - options.fade_out, 0.0)
        left = f"({duration:.3f}-T)/{options.fade_out:g}"
        curve = fades.expression(options.fade_out_curve or "linear", f"1-{left}")
        gain.append(f"if(gt(T,{start:.3f}),1-{curve},1)")
        when.append(f"gt(t,{start:.3f})")
    g = "*".join(gain)
    return (
        "format=yuv420p,"
        f"geq=lum='16+(lum(X,Y)-16)*{g}':cb='128+(cb(X,Y)-128)*{g}':cr='128+(cr(X,Y)-128)*{g}'"
        f":enable='{'+'.join(when) or '0'}'"
    )
