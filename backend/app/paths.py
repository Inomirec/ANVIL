r"""Пути приложения: где лежит конфиг, кэш превью и куда складывать результат.

Программа переносная: настройки, проекты, журнал и кэш лежат в папке ``data``
рядом с самой программой. Удалить программу — значит удалить одну папку,
в системе ничего не остаётся. ``%APPDATA%\SiGameHelper`` — только запасной
путь, если в папку программы писать нельзя, и старое место: оттуда данные
один раз переезжают сами (``migrate_legacy``).

``SGH_DATA_DIR`` в окружении задаёт папку явно — так проверочный сервер
живёт со своими настройками и не трогает настоящие.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = "SiGameHelper"


def _project_root() -> Path:
    """Корень репозитория (на два уровня выше этого файла)."""
    return Path(__file__).resolve().parents[2]


def is_frozen() -> bool:
    """True, если приложение запущено из собранного PyInstaller .exe."""
    return getattr(sys, "frozen", False)


def bundle_dir() -> Path:
    """Папка с ресурсами (статика фронтенда) — отличается в .exe и в исходниках."""
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent


def _writable(folder: Path) -> bool:
    try:
        folder.mkdir(parents=True, exist_ok=True)
        probe = folder / ".write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return True
    except OSError:
        return False


def legacy_dir() -> Path:
    """Где данные лежали раньше — в профиле пользователя."""
    base = os.environ.get("APPDATA") or os.environ.get("XDG_CONFIG_HOME")
    if base:
        return Path(base) / APP_NAME
    return Path.home() / f".{APP_NAME.lower()}"


_chosen: Path | None = None


def data_dir() -> Path:
    """Каталог для конфига, проектов, логов и кэша."""
    global _chosen
    override = os.environ.get("SGH_DATA_DIR")
    if override:
        return Path(override)
    if _chosen is None:
        portable = _project_root() / "data"
        _chosen = portable if portable.exists() or _writable(portable) else legacy_dir()
    return _chosen


#: Что из старой папки не переносим: запись установщика о том, куда он
#: поставил программу, — её читает сам установщик, и живёт она там.
_KEEP_IN_LEGACY = {"install.txt"}


def migrate_legacy() -> list[str]:
    """Перенести данные из старого места в папку программы — один раз.

    Переносим, только если в папке программы ещё нет своих настроек, а в
    старом месте они есть. Занятые файлы пропускаем: их перенесёт следующий
    запуск. Возвращает имена перенесённого — для журнала.
    """
    if os.environ.get("SGH_DATA_DIR"):
        return []
    target = data_dir()
    old = legacy_dir()
    if target == old or not (old / "config.json").exists() or (target / "config.json").exists():
        return []
    import shutil

    moved: list[str] = []
    target.mkdir(parents=True, exist_ok=True)
    for item in sorted(old.iterdir(), key=lambda path: path.name != "config.json"):
        if item.name in _KEEP_IN_LEGACY:
            continue
        destination = target / item.name
        try:
            if destination.exists():
                if item.is_dir() and destination.is_dir():
                    for child in item.iterdir():
                        if not (destination / child.name).exists():
                            shutil.move(str(child), str(destination / child.name))
                    shutil.rmtree(item, ignore_errors=True)
                continue
            shutil.move(str(item), str(destination))
            moved.append(item.name)
        except OSError:
            continue
    return moved


def ensure_dirs() -> None:
    for path in (data_dir(), thumbs_dir(), logs_dir()):
        path.mkdir(parents=True, exist_ok=True)


def config_file() -> Path:
    return data_dir() / "config.json"


def thumbs_dir() -> Path:
    return data_dir() / "thumbnails"


def logs_dir() -> Path:
    return data_dir() / "logs"


def default_workspace() -> Path:
    """Рабочая папка по умолчанию — ``Видео/SiGame Helper`` в профиле пользователя."""
    for candidate in ("Videos", "Видео"):
        folder = Path.home() / candidate
        if folder.exists():
            return folder / "SiGame Helper"
    return Path.home() / "SiGame Helper"


def static_dir() -> Path:
    """Собранный фронтенд."""
    return bundle_dir() / "static"
