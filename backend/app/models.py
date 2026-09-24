"""Pydantic-схемы запросов и ответов API."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

MediaKind = Literal["video", "audio", "image", "other"]
VideoCodec = Literal[
    "av1_svt", "av1_nvenc", "av1_qsv", "h264", "h264_nvenc", "h265", "copy"
]
AudioCodec = Literal["opus", "aac", "mp3", "flac", "copy", "none"]
ImageFormat = Literal["avif", "webp", "jpg", "png"]
Container = Literal["mp4", "webm", "mkv", "auto"]


class Trim(BaseModel):
    """Фрагмент исходника. ``None`` = от начала / до конца."""

    start: float | None = Field(default=None, ge=0)
    end: float | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _check_order(self) -> "Trim":
        if self.start is not None and self.end is not None and self.end <= self.start:
            raise ValueError("Точка Out должна быть позже точки In")
        return self

    @property
    def is_set(self) -> bool:
        return self.start is not None or self.end is not None

    @property
    def duration(self) -> float | None:
        if self.start is not None and self.end is not None:
            return self.end - self.start
        return None


class AudioOptions(BaseModel):
    codec: AudioCodec = "opus"
    #: Битрейт в кбит/с. Для ``flac``/``copy`` игнорируется.
    bitrate_kbps: int = Field(default=96, ge=16, le=512)
    #: Приводить громкость к единому уровню (EBU R128).
    loudnorm: bool = True
    #: Целевая интегральная громкость, LUFS.
    loudnorm_i: float = -16.0
    #: Максимальный истинный пик, dBTP.
    loudnorm_tp: float = -1.5
    #: Диапазон громкости, LU.
    loudnorm_lra: float = 11.0
    fade_in: float = Field(default=0.0, ge=0, le=30)
    fade_out: float = Field(default=0.0, ge=0, le=30)
    #: Привести к моно (заметно экономит вес для речи).
    mono: bool = False
    #: Какую звуковую дорожку брать, если их несколько. Считается по порядку
    #: среди звуковых, а не среди всех потоков файла.
    track: int = Field(default=0, ge=0, le=31)
    #: Громкость дорожки: 1.0 — как есть, 0 — совсем без звука. Ноль означает
    #: именно «выбросить дорожку», а не записать тишину: пустая дорожка всё
    #: равно занимает место и сбивает с толку в редакторе пака.
    volume: float = Field(default=1.0, ge=0.0, le=2.0)


class VideoOptions(BaseModel):
    codec: VideoCodec = "av1_svt"
    #: Постоянное качество. Для AV1 ~ 20-63, для x264/x265 ~ 0-51.
    crf: int = Field(default=43, ge=0, le=63)
    #: Целевой битрейт видео, кбит/с. Ноль — кодировать по качеству (обычный
    #: случай). Заданный битрейт нужен, когда важен предсказуемый вес файла.
    bitrate_kbps: int = Field(default=0, ge=0, le=200000)
    #: Скорость кодирования: для SVT-AV1 это 0-13, для x264 — имя пресета.
    speed_preset: str = "6"
    #: Подгонять качество под итоговое разрешение. Для паков это правильно:
    #: большому кадру нужно больше сжатия, чтобы вес остался прежним. Для
    #: архива — наоборот, там число должно означать ровно то, что задано.
    adapt_crf: bool = True
    #: Ограничение по высоте кадра (0 = не менять).
    max_height: int = Field(default=720, ge=0, le=4320)
    #: Ограничение по кадровой частоте (0 = не менять).
    max_fps: int = Field(default=30, ge=0, le=240)
    #: Ускорение воспроизведения: 1.0 = как в оригинале, 1.06 = +6%.
    tempo: float = Field(default=1.0, ge=0.5, le=2.0)
    #: Кодировать на видеокарте вместо процессора. Подходящий аппаратный
    #: кодировщик подбирается сам — какой есть в этом компьютере.
    use_gpu: bool = False
    container: Container = "mp4"
    #: Перемещать индекс в начало файла — обязательно для быстрого старта.
    faststart: bool = True
    #: Плавное появление из чёрного и уход в чёрный, в секундах.
    fade_in: float = Field(default=0.0, ge=0, le=30)
    fade_out: float = Field(default=0.0, ge=0, le=30)
    #: Убрать видеодорожку целиком (получить только звук).
    strip_video: bool = False


class Rect(BaseModel):
    """Прямоугольник в пикселях исходного изображения."""

    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    #: Цвет заливки. ``None`` — общий цвет из ``box_color``.
    color: str | None = None


class ImageOptions(BaseModel):
    format: ImageFormat = "avif"
    #: Закрашиваемые области (бренды, надписи, спойлеры). Координаты — в пикселях
    #: оригинала, до кадрирования и масштабирования.
    boxes: list[Rect] = Field(default_factory=list)
    #: Цвет закраски. По умолчанию непрозрачный чёрный.
    box_color: str = "black"
    #: Нарисованное кистью — прозрачный PNG размером с оригинал, в base64.
    #: Прямоугольником не закрыть надпись, идущую дугой, поэтому мазки
    #: приходят готовой картинкой и просто накладываются сверху.
    paint_png: str | None = None
    #: Обрезка кадра. ``None`` = оставить как есть.
    crop: Rect | None = None
    #: Качество 1-100.
    quality: int = Field(default=80, ge=1, le=100)
    #: Ограничение по длинной стороне в пикселях (0 = не менять).
    max_dimension: int = Field(default=1920, ge=0, le=16384)
    #: Усилие кодера: 0 = медленно и качественно, 8 = быстро.
    effort: int = Field(default=4, ge=0, le=9)


class ExportRequest(BaseModel):
    """Задание на обработку одного файла."""

    source: str
    kind: MediaKind
    trim: Trim = Field(default_factory=Trim)
    video: VideoOptions = Field(default_factory=VideoOptions)
    audio: AudioOptions = Field(default_factory=AudioOptions)
    image: ImageOptions = Field(default_factory=ImageOptions)
    #: Куда сохранить. ``None`` = подпапка рядом с исходником, её имя берётся
    #: из настроек.
    output_dir: str | None = None
    #: Имя файла без расширения. ``None`` = имя исходника + суффикс.
    output_name: str | None = None
    #: Суффикс, добавляемый к имени по умолчанию.
    suffix: str = "_sig"
    #: Быстрая нарезка потока без перекодирования (режет по ключевым кадрам).
    stream_copy: bool = False
    #: Человекочитаемое имя пресета — только для отображения в очереди.
    preset_label: str | None = None
    #: Перезаписывать существующий файл вместо добавления номера.
    overwrite: bool = False
    #: Убрать исходник в корзину после успешной обработки.
    replace_original: bool = False
    #: Разрешено ли взять другой формат, если выбранный не сохранит движение.
    #: Решает человек: программа спрашивает и подставляет ответ сюда.
    allow_format_switch: bool = False


class BatchExportRequest(BaseModel):
    items: list[ExportRequest]


class DownloadItem(BaseModel):
    """Одна ссылка в очереди загрузки, с необязательным отрезком."""

    url: str
    #: Начало и конец нужного фрагмента в секундах. Пусто = скачать целиком.
    start: float | None = Field(default=None, ge=0)
    end: float | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _check_order(self) -> "DownloadItem":
        if self.start is not None and self.end is not None and self.end <= self.start:
            raise ValueError("Конец отрезка должен быть позже начала")
        return self

    @property
    def has_section(self) -> bool:
        return self.start is not None or self.end is not None


class DownloadRequest(BaseModel):
    items: list[DownloadItem] = Field(min_length=1)
    #: ``auto`` сам решает по ссылке; остальные режимы принудительные.
    mode: Literal["auto", "video", "audio", "images"] = "auto"
    output_dir: str | None = None
    #: Ограничение высоты кадра при скачивании (0 = максимум).
    max_height: int = 0
    #: Для режима ``images``: индексы (с 1) выбранных картинок галереи.
    selection: list[int] | None = None
    #: Извлекать только звук (для режима ``audio``).
    audio_format: Literal["mp3", "opus", "m4a", "best"] = "opus"
    #: Сразу поставить скачанный файл в очередь сжатия с этим пресетом.
    auto_process_preset: str | None = None


class ProbeGalleryRequest(BaseModel):
    url: str


class SettingsPatch(BaseModel):
    """Свободная форма — валидируется при слиянии с текущим конфигом."""

    model_config = {"extra": "allow"}

    def as_dict(self) -> dict[str, Any]:
        return self.model_dump(exclude_unset=True)


class FrameGrabRequest(BaseModel):
    """Сохранение стоп-кадра из видео в отдельную картинку."""

    source: str
    #: Момент в секундах, с которого берём кадр.
    time: float = Field(ge=0)
    output_dir: str | None = None
    suffix: str = "_кадр"


class ImagePreviewRequest(BaseModel):
    """Просчёт превью: те же настройки, что и у экспорта, но без очереди."""

    source: str
    image: ImageOptions = Field(default_factory=ImageOptions)


class RawCommandRequest(BaseModel):
    """Запуск отредактированной вручную команды ffmpeg."""

    command: str
    #: Исходник — нужен только для подписи задачи в очереди.
    source: str | None = None


class PathRequest(BaseModel):
    path: str


class PickFileRequest(BaseModel):
    """В какой папке открыть окно выбора файла."""

    directory: str | None = None


class PathsRequest(BaseModel):
    paths: list[str]


class RenameRequest(BaseModel):
    path: str
    new_name: str


# --- монтаж -------------------------------------------------------------

ClipKind = Literal["video", "image", "audio", "color", "text"]


class ComposeModel(BaseModel):
    """Общая основа для моделей монтажа.

    Интерфейс пишет имена полей по-своему (``sourceIn``), а Python — по-своему
    (``source_in``). Раньше это расходилось молча: лишние поля Pydantic просто
    отбрасывал, и обрезка клипа до сервера не доходила — вторая половина
    разрезанного ролика собиралась с начала файла. Теперь понимаются оба
    написания.
    """

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class ClipEffect(ComposeModel):
    """Эффект клипа: какой, включён ли и с какими настройками.

    Настройки — числа в шкале, которую видит человек («теплее на 30»);
    в числа ffmpeg их переводит ``core.effects``. Поля, нужные только окну
    (свёрнут ли эффект в колонке), сервер просто не читает.
    """

    id: str
    type: str
    on: bool = True
    params: dict[str, float | str] = Field(default_factory=dict)


class ComposeClip(ComposeModel):
    """Один кусок на дорожке монтажа.

    ``start`` и ``duration`` — про место на таймлайне, ``source_in`` — про сам
    файл: с какой его секунды начинать. Разрезать клип надвое значит сделать
    из него два с общим файлом и разными ``source_in``.
    """

    id: str
    source: str
    kind: ClipKind
    #: Где стоит на таймлайне, в секундах от начала.
    start: float = Field(default=0.0, ge=0)
    #: Сколько занимает на таймлайне. У картинки — сколько висит на экране.
    duration: float = Field(gt=0)
    #: С какой секунды самого файла берём. У картинок не имеет смысла.
    source_in: float = Field(default=0.0, ge=0)
    #: Есть ли в файле звуковая дорожка. ``None`` = ещё не выясняли; сервер
    #: узнаёт это сам перед сборкой. Просить у ffmpeg дорожку, которой нет, —
    #: значит уронить всю сборку.
    has_audio: bool | None = None
    #: Громкость: 1.0 — как есть, 0 — тишина.
    volume: float = Field(default=1.0, ge=0.0, le=4.0)
    #: Плавное появление и уход звука, в секундах.
    fade_in: float = Field(default=0.0, ge=0, le=30)
    fade_out: float = Field(default=0.0, ge=0, le=30)
    #: Выбросить звук у этого клипа. Нужно, когда под видео кладут музыку и
    #: родная дорожка ролика только мешает.
    muted: bool = False
    #: Непрозрачность картинки: 1 — как есть, 0 — совсем не видно. Нужна для
    #: наложений: сквозь полупрозрачный верхний слой виден нижний.
    opacity: float = Field(default=1.0, ge=0.0, le=1.0)
    #: Приближение внутри кадра: 1 — вписать целиком, 2 — вдвое крупнее с
    #: обрезкой по краям.
    zoom: float = Field(default=1.0, ge=1.0, le=8.0)
    #: Цвет сплошной заливки — только у клипов вида ``color``. Файла у такого
    #: клипа нет, картинку рисует сам ffmpeg.
    color: str = Field(default="#000000", pattern=r"^#[0-9a-fA-F]{6}$")
    #: Размер клипа в кадре: 1 — вписан в кадр целиком, 0.5 — вчетверо меньше,
    #: 2 — вдвое крупнее кадра (края уйдут за границы). Так делают «картинку в
    #: картинке» и наезды.
    size: float = Field(default=1.0, gt=0.0, le=4.0)
    #: Высота клипа в долях кадра, если она задана отдельно от ширины. Ноль —
    #: «как ширина»: клип сохраняет свою форму. Нужно, чтобы растянуть заливку
    #: полосой или прямоугольником любой формы.
    size_y: float = Field(default=0.0, ge=0.0, le=4.0)
    #: Форма исходника: ширина, делённая на высоту. Ноль — неизвестна. По ней
    #: считается высота рамки, когда её не задали отдельно: иначе квадратная
    #: картинка в широком кадре лежала бы внутри пустой рамки, и выровнять её
    #: по краю было бы не по чему.
    ratio: float = Field(default=0.0, ge=0.0, le=100.0)
    #: Где стоит середина клипа, в долях кадра: 0.5 — посередине, 0 — у левого
    #: (верхнего) края. Значения за пределами 0..1 допустимы: клип можно увести
    #: за край кадра частично.
    x: float = Field(default=0.5, ge=-1.0, le=2.0)
    y: float = Field(default=0.5, ge=-1.0, le=2.0)

    # --- эффекты ------------------------------------------------------------
    #: Эффекты по порядку: цветокоррекция, размытие, шумоподавление голоса…
    effects: list[ClipEffect] = Field(default_factory=list)
    #: Отразить по горизонтали и по вертикали.
    flip_h: bool = False
    flip_v: bool = False
    #: Повернуть по часовой стрелке: 0, 90, 180 или 270 градусов.
    rotate: int = Field(default=0, ge=0, le=270)
    #: Играть задом наперёд — и картинку, и звук.
    reverse: bool = False
    #: Обрезка: сколько отрезать с каждой стороны, в долях картинки. Отрезанное
    #: становится прозрачным, оставшееся стоит на своём месте и своего размера.
    crop_left: float = Field(default=0.0, ge=0.0, le=0.95)
    crop_top: float = Field(default=0.0, ge=0.0, le=0.95)
    crop_right: float = Field(default=0.0, ge=0.0, le=0.95)
    crop_bottom: float = Field(default=0.0, ge=0.0, le=0.95)
    #: Скорость: 2 — вдвое быстрее, 0.5 — вдвое медленнее. ``duration`` —
    #: место на таймлайне, а из файла берётся ``duration * speed`` секунд.
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    #: Размер самого файла в пикселях. Узнаёт сервер перед сборкой, и только
    #: когда нужно: удаление водяного знака берёт место в пикселях файла.
    source_width: int = 0
    source_height: int = 0
    #: Ровная копия ролика после стабилизатора. Ставит сервер перед сборкой,
    #: когда копия готова: тогда монтаж читает её вместо исходника.
    stable_source: str = ""

    # --- надпись (только у клипов вида ``text``) --------------------------
    #: Что написать. Переводы строк сохраняются: так набирают субтитры в две
    #: строки, и ломать их по ширине кадра за человека не надо.
    text: str = ""
    #: Имя семейства шрифта, как его знает Windows: «Arial», «Segoe UI».
    #: Пустое — возьмём то, что найдётся: монтаж могли принести с другой
    #: машины, где этого шрифта нет.
    font: str = ""
    bold: bool = False
    italic: bool = False
    #: Высота букв в долях высоты кадра. Так надпись не меняет размера, когда
    #: проект переводят с 720p на 1080p.
    font_size: float = Field(default=0.08, gt=0.0, le=1.0)
    #: Цвет букв и насколько они видны.
    text_color: str = Field(default="#ffffff", pattern=r"^#[0-9a-fA-F]{6}$")
    #: Обводка вокруг букв: её толщина в долях высоты кадра и цвет. Без неё
    #: светлый текст теряется на светлом кадре. Включатель отдельно от
    #: толщины: выключенная обводка помнит свои настройки и возвращается
    #: такой же, какой была.
    stroke_on: bool = False
    stroke: float = Field(default=0.0, ge=0.0, le=0.2)
    stroke_color: str = Field(default="#000000", pattern=r"^#[0-9a-fA-F]{6}$")
    #: Тень: сдвиг в долях высоты кадра (может быть отрицательным) и цвет.
    #: Включатель, как и у обводки, отдельно от настроек.
    shadow_on: bool = False
    shadow_x: float = Field(default=0.0, ge=-0.5, le=0.5)
    shadow_y: float = Field(default=0.0, ge=-0.5, le=0.5)
    shadow_color: str = Field(default="#000000", pattern=r"^#[0-9a-fA-F]{6}$")
    #: Насколько видна тень: 0 — её нет вовсе.
    shadow_alpha: float = Field(default=0.6, ge=0.0, le=1.0)
    #: Подложка под текстом: цвет, прозрачность и отступ от букв.
    box: bool = False
    box_color: str = Field(default="#000000", pattern=r"^#[0-9a-fA-F]{6}$")
    box_alpha: float = Field(default=0.5, ge=0.0, le=1.0)
    box_pad: float = Field(default=0.02, ge=0.0, le=0.5)
    #: Выравнивание строк между собой, когда их несколько.
    align: Literal["left", "center", "right"] = "center"

    # --- заливка (только у клипов вида ``color``) ------------------------
    #: Скругление углов в долях высоты кадра. Обводка и тень у заливки общие
    #: с надписью — те же поля ``stroke*`` и ``shadow*``.
    radius: float = Field(default=0.0, ge=0.0, le=1.0)
    #: Готовая картинка заливки со скруглением, рамкой и тенью. Заполняет её
    #: сервер перед сборкой (``compose.prepare_fills``), интерфейс её не шлёт.
    fill_image: str = ""

    @property
    def end(self) -> float:
        return self.start + self.duration


class ComposeTrack(ComposeModel):
    """Дорожка. Порядок в списке — порядок слоёв: **первая поверх всех**.

    Так же она и нарисована на таймлайне: верхняя дорожка — верхний слой, как
    в монтажных программах.
    """

    id: str
    kind: Literal["video", "audio"] = "video"
    clips: list[ComposeClip] = Field(default_factory=list)
    #: Название дорожки. Пустое — человек его не задавал.
    name: str = ""
    #: Уровень всей дорожки: у звука это громкость, у видео — насколько видно
    #: то, что на ней лежит. Умножается на то же самое у каждого клипа.
    level: float = Field(default=1.0, ge=0.0, le=4.0)


class ComposeProject(ComposeModel):
    """Монтаж целиком — то, что видно на таймлайне."""

    #: Размер итогового кадра. Всё, что не подходит, вписывается внутрь с
    #: чёрными полями: обрезать чужой кадр за человека нельзя.
    width: int = Field(default=1280, ge=16, le=7680)
    height: int = Field(default=720, ge=16, le=4320)
    fps: int = Field(default=30, ge=1, le=120)
    #: Громкость всего монтажа разом — фейдер мастер-шины. Влияет на готовый
    #: файл, в отличие от громкости прослушивания.
    master_volume: float = Field(default=1.0, ge=0.0, le=4.0)
    #: Привести громкость готового файла к единому уровню (EBU R128) — то же
    #: выравнивание, что и при обычной обработке.
    loudnorm: bool = False
    tracks: list[ComposeTrack] = Field(default_factory=list)

    @property
    def duration(self) -> float:
        """До какой секунды тянется самый дальний клип."""
        return max(
            (clip.end for track in self.tracks for clip in track.clips),
            default=0.0,
        )


class ComposeCheckRequest(BaseModel):
    """Пути файлов монтажа — проверить, на месте ли они."""

    sources: list[str]


class ComposeFindRequest(BaseModel):
    """Где искать пропавшие файлы и какие именно."""

    folder: str
    sources: list[str]


class StabilizeRequest(BaseModel):
    """Готова ли ровная копия ролика с такими настройками стабилизатора."""

    source: str
    params: dict[str, float | str] = Field(default_factory=dict)


class ComposeFrameRequest(ComposeModel):
    """Кадр композиции под иглой — для окна просмотра."""

    project: ComposeProject
    #: Момент на таймлайне, в секундах.
    at: float = Field(default=0.0, ge=0)
    #: Ширина картинки предпросмотра. Кадр проекта может быть 4K, а окну
    #: столько не нужно — лишние пиксели только замедляют просчёт.
    preview_width: int = Field(default=960, ge=160, le=3840)


class ComposeDraftRequest(ComposeModel):
    """Черновик куска монтажа — чтобы посмотреть, как оно играет.

    Собирается быстрым кодеком и в мелком кадре: живёт этот файл секунды и
    нужен только для просмотра, а вес и качество здесь не важны.
    """

    project: ComposeProject
    #: С какой секунды монтажа начинать.
    at: float = Field(default=0.0, ge=0)
    #: Сколько секунд собрать за раз.
    span: float = Field(default=12.0, gt=0, le=60)
    #: Высота кадра черновика. Меньше — быстрее собирается.
    height: int = Field(default=360, ge=144, le=1080)


class ComposeProjectFile(ComposeModel):
    """Сохранение монтажа в файл.

    ``project`` — то, что прислал интерфейс, как есть. Разбирать его серверу
    незачем: часть полей нужна только окну, а состав меняется вместе с
    вкладкой.
    """

    name: str = "Монтаж"
    project: dict


class ComposeSnapshotRequest(ComposeModel):
    """Снимок кадра монтажа — то же, что «Сохранить кадр» в медиатеке.

    Кадр берётся в полном размере проекта и сохраняется PNG без сжатия:
    сжимать его, если понадобится, есть чем — обычной панелью картинок.
    """

    project: ComposeProject
    #: Момент на таймлайне, в секундах.
    at: float = Field(default=0.0, ge=0)
    #: Куда сохранить. ``None`` = подпапка рядом с первым файлом монтажа.
    output_dir: str | None = None
    #: Имя файла без расширения; к нему приписывается время кадра.
    output_name: str = "Монтаж"


class ComposeRender(ComposeModel):
    """Чем кодировать готовый монтаж.

    Пресеты обычной обработки сюда не годятся: они про то, как ужать чужой
    файл до веса пака, а монтаж человек собирает начисто и сам решает, что ему
    нужно. Поэтому настройки заданы прямо здесь, а пресеты к ним человек
    складывает свои.
    """

    video_codec: VideoCodec = "av1_svt"
    #: Постоянное качество: меньше число — лучше картинка и больше файл.
    crf: int = Field(default=24, ge=0, le=63)
    #: Целевой битрейт видео, кбит/с. Ноль — считать по качеству.
    bitrate_kbps: int = Field(default=0, ge=0, le=200000)
    #: Скорость кодирования: у AV1 это число, у H.264 — название пресета.
    speed_preset: str = "5"
    #: Кодировать на видеокарте. Подходящий кодировщик подбирается сам.
    use_gpu: bool = False
    audio_codec: AudioCodec = "opus"
    audio_bitrate_kbps: int = Field(default=192, ge=16, le=512)
    container: Container = "mp4"


class ComposeBuildRequest(ComposeModel):
    """Сборка монтажа в готовый файл — обычной задачей в очереди."""

    project: ComposeProject
    #: Чем кодировать. ``None`` — старое поведение через ``preset_id``.
    render: ComposeRender | None = None
    #: Куда сохранить. ``None`` = подпапка рядом с первым файлом монтажа.
    output_dir: str | None = None
    #: Имя файла без расширения.
    output_name: str = "Монтаж"
    #: Пресет сжатия из общего каталога. ``None`` = «Баланс».
    preset_id: str | None = None
    #: Отрезок монтажа, который собираем. ``None`` = от начала и до конца
    #: последнего клипа. Метки ставит человек клавишами I и O.
    start: float | None = Field(default=None, ge=0)
    end: float | None = Field(default=None, ge=0)
