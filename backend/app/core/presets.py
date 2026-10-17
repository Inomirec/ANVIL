"""Каталог пресетов сжатия.

Пресет — это просто именованный набор значений для ``VideoOptions`` /
``AudioOptions`` / ``ImageOptions``. Пользователь выбирает пресет, а затем
может подкрутить любой параметр вручную.

Ориентиры по качеству для SVT-AV1 (CRF):
  38-40 — высокое качество, файл крупнее
  42-45 — золотая середина для паков
  50+   — максимальная экономия, видны артефакты
"""

from __future__ import annotations

from typing import Any, Literal

PresetKind = Literal["video", "audio", "image"]


class Preset(dict):
    """Словарь вида ``{id, label, hint, kind, options}``."""


#: Понятные названия кодеков для подписи под пресетом.
_CODEC_NAMES = {
    "av1_svt": "AV1",
    "av1_nvenc": "AV1",
    "h264": "H.264",
    "h264_nvenc": "H.264",
    "h265": "H.265",
    "copy": "как есть",
    "opus": "Opus",
    "aac": "AAC",
    "mp3": "MP3",
}


def _tech(video: dict[str, Any], audio: dict[str, Any]) -> str:
    """Строка вида «AV1 · Opus 96k · качество 43».

    Человеку не нужно знать, что такое CRF, чтобы им пользоваться, — но
    видеть, чем один пресет отличается от другого, полезно: иначе выбор
    между «Балансом» и «Качеством» превращается в гадание.
    """
    parts = [_CODEC_NAMES.get(video.get("codec", ""), video.get("codec", ""))]

    sound = _CODEC_NAMES.get(audio.get("codec", ""), audio.get("codec", ""))
    if audio.get("bitrate_kbps"):
        sound = f"{sound} {audio['bitrate_kbps']}k"
    parts.append(sound)

    if video.get("codec") != "copy" and video.get("crf") is not None:
        # Ноль у кодеков означает «без потерь», но подпись «качество 0»
        # читается ровно наоборот — пишем словами.
        parts.append("без потерь" if video["crf"] == 0 else f"качество {video['crf']}")
    return " · ".join(parts)


def _video(
    ident: str,
    label: str,
    hint: str,
    *,
    codec: str = "av1_svt",
    crf: int = 43,
    adapt_crf: bool = True,
    speed_preset: str = "6",
    max_height: int = 720,
    max_fps: int = 30,
    audio_codec: str = "opus",
    audio_bitrate: int = 96,
    loudnorm: bool = True,
    container: str = "mp4",
    accent: str = "violet",
) -> dict[str, Any]:
    video = {
        "codec": codec,
        "crf": crf,
        "adapt_crf": adapt_crf,
        "speed_preset": speed_preset,
        "max_height": max_height,
        "max_fps": max_fps,
        "tempo": 1.0,
        "container": container,
        "faststart": True,
        "strip_video": False,
    }
    audio = {
        "codec": audio_codec,
        "bitrate_kbps": audio_bitrate,
        "loudnorm": loudnorm,
    }
    return {
        "id": ident,
        "kind": "video",
        "label": label,
        "hint": hint,
        "tech": _tech(video, audio),
        "accent": accent,
        "options": {"video": video, "audio": audio},
    }


def _audio(
    ident: str,
    label: str,
    hint: str,
    *,
    codec: str = "opus",
    bitrate: int = 96,
    loudnorm: bool = True,
    fade_out: float = 0.0,
    mono: bool = False,
    accent: str = "emerald",
) -> dict[str, Any]:
    names = {"opus": "Opus", "mp3": "MP3", "aac": "AAC", "flac": "FLAC"}
    return {
        "id": ident,
        "kind": "audio",
        "label": label,
        "hint": hint,
        "tech": f"{names.get(codec, codec.upper())} · {bitrate} кбит/с",
        "accent": accent,
        "options": {
            "audio": {
                "codec": codec,
                "bitrate_kbps": bitrate,
                "loudnorm": loudnorm,
                "fade_out": fade_out,
                "mono": mono,
            }
        },
    }


def _image(
    ident: str,
    label: str,
    hint: str,
    *,
    fmt: str = "avif",
    quality: int = 80,
    max_dimension: int = 1920,
    effort: int = 4,
    accent: str = "amber",
) -> dict[str, Any]:
    names = {"avif": "AVIF", "webp": "WebP", "jpg": "JPEG", "png": "PNG"}
    tech = [names.get(fmt, fmt.upper()), f"качество {quality}"]
    if max_dimension:
        tech.append(f"до {max_dimension} px")

    return {
        "id": ident,
        "kind": "image",
        "label": label,
        "hint": hint,
        "tech": " · ".join(tech),
        "accent": accent,
        "options": {
            "image": {
                "format": fmt,
                "quality": quality,
                "max_dimension": max_dimension,
                "effort": effort,
            }
        },
    }


VIDEO_PRESETS: list[dict[str, Any]] = [
    _video(
        "pack_balanced",
        "Баланс",
        "Используется чаще всего. Даёт оптимальное сжатие практически без "
        "потери качества.",
        crf=43,
    ),
    _video(
        "pack_economy",
        "Экономия",
        "Для сильного сжатия: файл примерно вдвое легче, чем у «Баланса». "
        "Действие и сцену видно, но мелкие детали размываются.",
        # Замер на 10 с аниме 720p: «Баланс» (43) — 364 КБ, 55 — 199 КБ.
        # Прежние 50 давали 256 КБ — слишком близко к «Балансу».
        crf=55,
        audio_bitrate=64,
    ),
    _video(
        "pack_quality",
        "Качество",
        "На глаз почти неотличимо от исходника, частота кадров не меняется. "
        "Сжимает слабее остальных, но обычный ролик всё равно уменьшится в "
        "разы. Годится и для архива.",
        # Бывший «Архив»: прежнее «Качество» (38) почти не отличалось от
        # «Баланса». Заданное качество применяется как есть — подгонка под
        # разрешение нужна пакам, а здесь молча ухудшала бы 1080p и 4K.
        crf=30,
        adapt_crf=False,
        max_fps=0,
        audio_bitrate=128,
        accent="amber",
    ),
    _video(
        "pack_h264",
        "H.264 Баланс",
        "Наиболее стабильный кодек, он проигрывается на большинстве старых "
        "компьютеров. Сжимает немного хуже.",
        codec="h264",
        crf=25,
        speed_preset="fast",
        audio_codec="aac",
        audio_bitrate=128,
        accent="sky",
    ),
    _video(
        "remux_mp4",
        "Конвертация в H.264",
        "Переводит видео в формат, который читается любой программой, — например, "
        "чтобы отдать его в монтаж. Качество на глаз не меняется, но файл из "
        "сжатого исходника вырастет в несколько раз. Не подходит для сжатия.",
        codec="h264",
        # Неотличимо на глаз, а не буквально без потерь. Без потерь (crf 0)
        # сжатый исходник вырастал в 17–25 раз: 2 МБ превращались в 50. Замер
        # на ролике 1080p из AV1: crf 16 — в 4.7 раза, отличие от исходника
        # 52.6 дБ (порогом «неотличимо» считают около 45). Подгонку под
        # разрешение не включаем: число должно значить ровно это.
        crf=16,
        adapt_crf=False,
        speed_preset="medium",
        max_height=0,
        max_fps=0,
        audio_codec="aac",
        audio_bitrate=320,
        accent="emerald",
    ),
    {
        "id": "stream_copy",
        "kind": "video",
        "label": "Без сжатия",
        "hint": "Когда нужно обрезать видео, сохранив исходное качество. Мгновенно, "
                "но границы среза прыгнут к ближайшим ключевым кадрам.",
        "tech": "как есть",
        "accent": "slate",
        "options": {
            "video": {"codec": "copy", "max_height": 0, "max_fps": 0},
            "audio": {"codec": "copy", "loudnorm": False},
            "stream_copy": True,
        },
    },
]

AUDIO_PRESETS: list[dict[str, Any]] = [
    # Два готовых набора, по одному на кодек; битрейт и кодек человек
    # подстраивает под ними сам — ползунок с подписанными значениями.
    _audio(
        "opus_96",
        "Баланс · Opus",
        "Обычный выбор для вопросов. Звучит примерно как MP3 160, а весит "
        "втрое меньше.",
    ),
    _audio(
        "mp3_192_compat",
        "Баланс · MP3",
        "Для старых плееров и сайтов, которые не понимают Opus.",
        codec="mp3",
        bitrate=192,
        accent="sky",
    ),
]

IMAGE_PRESETS: list[dict[str, Any]] = [
    _image(
        "avif_recommended",
        "Рекомендуемое сжатие",
        "Подходит почти всегда: постеры, кадры, фотографии, схемы. "
        "Разницу на глаз почти не видно.",
        quality=94,
        max_dimension=0,
        effort=4,
    ),
    _image(
        "jpeg_compatible",
        "JPEG",
        "Когда важнее совместимость: JPEG открывает вообще всё, "
        "включая предпросмотр в редакторе пака.",
        fmt="jpg",
        quality=85,
        max_dimension=0,
        accent="sky",
    ),
    _image(
        "avif_archive",
        "Архив",
        "Сжимает картинку путём перевода в более экономный формат. Размер "
        "кадра остаётся прежним, разницу на глаз не видно. Можно "
        "использовать, чтобы архивировать старые картинки.",
        # Верх шкалы. Выше уже нечего брать: у AVIF лучшее качество, которое
        # даёт кодировщик в этом режиме, приходится ровно на сотню.
        quality=100,
        # Размер кадра не трогаем: предел в 1600 px нужен пакам, а в архиве
        # картинка должна остаться такой, какой была.
        max_dimension=0,
        accent="emerald",
    ),
]


ALL: list[dict[str, Any]] = VIDEO_PRESETS + AUDIO_PRESETS + IMAGE_PRESETS
_BY_ID = {preset["id"]: preset for preset in ALL}


def get(preset_id: str) -> dict[str, Any] | None:
    return _BY_ID.get(preset_id)


def catalog() -> dict[str, list[dict[str, Any]]]:
    return {"video": VIDEO_PRESETS, "audio": AUDIO_PRESETS, "image": IMAGE_PRESETS}
