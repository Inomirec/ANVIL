"""Шрифты, установленные в системе.

Текст на видео рисует ffmpeg, и ему нужен не «Arial», а путь к файлу шрифта.
Причём начертания — это разные файлы: `arial.ttf`, `arialbd.ttf` (жирный),
`ariali.ttf` (курсив), `arialbi.ttf` (жирный курсив). Поэтому список собираем
сами: семейство, а в нём — какие начертания есть и где они лежат.

Откуда берём: реестр Windows. Там у каждого шрифта человеческое имя вида
«Arial Bold Italic (TrueType)» — по нему и разбираем семейство с начертанием.
Читать сами файлы шрифтов ради имён не нужно.
"""

from __future__ import annotations

import os
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

#: Ветка реестра со списком шрифтов — одна и та же для системных и своих.
_BRANCH = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"

#: Файлы, которые ffmpeg не откроет: у растровых шрифтов нет контуров.
_USABLE = {".ttf", ".otf", ".ttc"}

#: Слова в имени, по которым узнаём начертание. Порядок важен: «Bold Italic»
#: должно разобраться раньше, чем просто «Bold». «Regular» — обычное
#: начертание: его тоже отрезаем, иначе шрифт «Pribambas-Regular» так и
#: назывался бы, а браузер знает его как «Pribambas».
_STYLES = (
    ("bold italic", True, True),
    ("bolditalic", True, True),
    ("italic bold", True, True),
    ("bold oblique", True, True),
    ("italic", False, True),
    ("oblique", False, True),
    ("bold", True, False),
    ("regular", False, False),
)


@dataclass
class Family:
    """Семейство шрифтов и его начертания."""

    name: str
    #: Пути к файлам: обычный, жирный, курсив, жирный курсив.
    regular: str = ""
    bold: str = ""
    italic: str = ""
    bold_italic: str = ""

    def pick(self, bold: bool, italic: bool) -> str:
        """Файл под нужное начертание, с откатом на то, что есть.

        Просить у ffmpeg жирный файл, которого нет, нельзя — он откажется
        рисовать вовсе. Лучше нарисовать обычным: человек увидит текст, пусть
        и не таким жирным, как хотел.
        """
        if bold and italic:
            return self.bold_italic or self.bold or self.italic or self.regular
        if bold:
            return self.bold or self.regular or self.bold_italic
        if italic:
            return self.italic or self.regular or self.bold_italic
        return self.regular or self.bold or self.italic or self.bold_italic

    def to_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "bold": bool(self.bold or self.bold_italic),
            "italic": bool(self.italic or self.bold_italic),
        }


def _split_style(label: str) -> tuple[str, bool, bool]:
    """Разбирает «Arial Bold Italic» на семейство и начертание."""
    clean = label.split("(")[0].strip()
    low = clean.lower()
    for mark, bold, italic in _STYLES:
        # Начертание пишут и через пробел («Arial Bold»), и через дефис
        # («Pribambas-Regular») — так их называют сами файлы шрифтов.
        for joint in (" ", "-"):
            if low.endswith(joint + mark) or low.endswith(joint + mark.replace(" ", "")):
                cut = len(mark) + 1 if low.endswith(joint + mark) else len(mark.replace(" ", "")) + 1
                return clean[:-cut].strip(" -"), bold, italic
    # «Arial Black» и «Arial Narrow» — это отдельные семейства, а не начертания.
    return clean, False, False


def _font_dirs() -> list[Path]:
    dirs = [Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"]
    local = os.environ.get("LOCALAPPDATA")
    if local:
        dirs.append(Path(local) / "Microsoft" / "Windows" / "Fonts")
    return dirs


def _resolve(value: str) -> str:
    """Путь к файлу шрифта: в реестре бывает и одно имя, и полный путь."""
    candidate = Path(value)
    if candidate.is_absolute():
        return str(candidate) if candidate.is_file() else ""
    for folder in _font_dirs():
        found = folder / value
        if found.is_file():
            return str(found)
    return ""


def _read_branch(root: object) -> list[tuple[str, str]]:
    import winreg  # noqa: PLC0415 — модуль есть только на Windows

    try:
        key = winreg.OpenKey(root, _BRANCH)  # type: ignore[arg-type]
    except OSError:
        return []
    rows: list[tuple[str, str]] = []
    index = 0
    while True:
        try:
            label, value, _ = winreg.EnumValue(key, index)
        except OSError:
            break
        index += 1
        if isinstance(value, str):
            rows.append((label, value))
    return rows


_families: list[Family] | None = None


def families(refresh: bool = False) -> list[Family]:
    """Список семейств, отсортированный по имени.

    Читается один раз: шрифты в системе за время работы программы меняются
    редко, а обход реестра ради каждого текстового клипа не нужен.
    """
    global _families
    if _families is not None and not refresh:
        return _families

    found: dict[str, Family] = {}
    if sys.platform == "win32":
        import winreg  # noqa: PLC0415

        rows = _read_branch(winreg.HKEY_LOCAL_MACHINE) + _read_branch(winreg.HKEY_CURRENT_USER)
        for label, value in rows:
            # В одном файле может лежать несколько шрифтов («a.ttc») — реестр
            # перечисляет их через запятую в имени, берём первое.
            first = value.split(",")[0].strip()
            if Path(first).suffix.lower() not in _USABLE:
                continue
            path = _resolve(first)
            if not path:
                continue
            name, bold, italic = _split_style(label.split("&")[0])
            if not name:
                continue
            family = found.setdefault(name, Family(name=name))
            if bold and italic:
                family.bold_italic = family.bold_italic or path
            elif bold:
                family.bold = family.bold or path
            elif italic:
                family.italic = family.italic or path
            else:
                family.regular = family.regular or path

    _families = sorted(
        (item for item in found.values() if item.pick(False, False)),
        key=lambda item: item.name.lower(),
    )
    return _families


def path_for(name: str, bold: bool = False, italic: bool = False) -> str:
    """Файл шрифта под имя семейства и начертание.

    Неизвестное имя не повод отказываться рисовать: берём первое, что есть, —
    чаще всего это Arial. Иначе сборка падала бы из-за шрифта, которого нет на
    этом компьютере, хотя монтаж делали на другом.
    """
    for family in families():
        if family.name.lower() == name.lower():
            return family.pick(bold, italic)
    # Имя могли записать прежней версией — с начертанием в хвосте
    # («Pribambas-Regular»). Отрезаем его так же, как при чтении списка.
    short, _, _ = _split_style(name)
    for family in families():
        if family.name.lower() == short.lower():
            return family.pick(bold, italic)
    for fallback in ("Arial", "Segoe UI", "Tahoma"):
        for family in families():
            if family.name.lower() == fallback.lower():
                return family.pick(bold, italic)
    return families()[0].pick(bold, italic) if families() else ""


_line_heights: dict[str, float] = {}


def line_height(path: str) -> float:
    """Шаг между строками в долях размера букв — ровно как у ffmpeg.

    ffmpeg ставит строки надписи на высоту, записанную в самом шрифте:
    таблица `hhea` — высота над строкой, под ней и зазор, делённые на
    размер буквы в единицах шрифта. Проверено на четырёх шрифтах: шаг строк
    в готовом кадре совпадает с этим числом до тысячных. Окно берёт то же
    число, поэтому строки на превью и в файле стоят одинаково.

    Сломанный или странный файл не повод падать — берём обычное 1.2.
    """
    if path in _line_heights:
        return _line_heights[path]
    ratio = 1.2
    try:
        data = Path(path).read_bytes()
        base = struct.unpack(">I", data[12:16])[0] if data[:4] == b"ttcf" else 0
        count = struct.unpack(">H", data[base + 4 : base + 6])[0]
        tables: dict[bytes, int] = {}
        for index in range(count):
            entry = base + 12 + index * 16
            tables[data[entry : entry + 4]] = struct.unpack(">I", data[entry + 8 : entry + 12])[0]
        units = struct.unpack(">H", data[tables[b"head"] + 18 : tables[b"head"] + 20])[0]
        ascent, descent, gap = struct.unpack(">hhh", data[tables[b"hhea"] + 4 : tables[b"hhea"] + 10])
        if units > 0 and ascent - descent > 0:
            ratio = (ascent - descent + gap) / units
    except (OSError, KeyError, struct.error, IndexError):
        pass
    _line_heights[path] = ratio
    return ratio
