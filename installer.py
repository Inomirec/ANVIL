"""ANVIL — единственный файл, на который нажимает человек.

Он и устанавливает программу, и запускает её. Что именно делать, решает сам:

* рядом лежит готовое окружение (папка ``runtime``, а у разработчика
  ``.venv``) — молча открывает программу, как обычный ярлык;
* окружения нет — показывает окно установки, спрашивает куда ставить,
  нужен ли ярлык, и только по кнопке «Установить» берётся за дело.

Раньше файлов было два — установщик и запускалка, — и это сбивало с толку:
в архиве с GitHub оказывался не тот, что в релизе. Теперь файл один и ведёт
себя одинаково, откуда бы его ни взяли.
"""

from __future__ import annotations

import contextlib
import os
import queue
import shutil
import subprocess
import sys
import threading
import urllib.request
import zipfile
from pathlib import Path

APP_NAME = "ANVIL"
#: Так программа называлась раньше: его файл и ярлык убираем при обновлении.
OLD_NAME = "SiGame Helper"
PYTHON_VERSION = "3.12.10"
PYTHON_ZIP = (
    f"https://www.python.org/ftp/python/{PYTHON_VERSION}/"
    f"python-{PYTHON_VERSION}-embed-amd64.zip"
)
GET_PIP = "https://bootstrap.pypa.io/get-pip.py"

#: Чтобы дочерние процессы не открывали чёрных окон.
CREATE_NO_WINDOW = 0x08000000

#: Цвета окна установки — те же, что у самой программы (index.css).
BG = "#1b1b1b"
SURFACE = "#202020"
SURFACE_2 = "#272727"
SURFACE_3 = "#313131"
LINE = "#3b3b3b"
LINE_SOFT = "#2d2d2d"
INK = "#f4f4f4"
INK_DIM = "#b5b5b5"
INK_FAINT = "#8b8b8b"
ACCENT = "#169c91"
ACCENT_STRONG = "#12857b"
DANGER = "#ef7a73"


def own_dir() -> Path:
    """Папка, в которой лежит сам файл."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def payload_dir() -> Path:
    """Откуда брать файлы программы при установке.

    Если рядом с нами уже лежит ``backend`` — значит нас распаковали вместе
    с исходниками, и брать надо их: они точно свежее упакованных внутрь.
    Иначе достаём копию из самого файла.
    """
    here = own_dir()
    if (here / "backend").is_dir():
        return here
    bundled = getattr(sys, "_MEIPASS", None)
    return Path(bundled) if bundled else here


def read_version(folder: Path) -> str | None:
    """Версия программы, лежащей в папке. None — программы там нет."""
    marker = folder / "backend" / "app" / "__init__.py"
    try:
        for line in marker.read_text(encoding="utf-8").splitlines():
            if line.startswith("__version__"):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        return None
    return None


def payload_version() -> str | None:
    """Версия, которую принёс с собой этот файл."""
    return read_version(payload_dir())


def memory_file() -> Path:
    """Где запоминаем, куда программа установлена."""
    base = os.environ.get("APPDATA") or str(Path.home())
    return Path(base) / "SiGameHelper" / "install.txt"


def remember_install(folder: Path) -> None:
    try:
        record = memory_file()
        record.parent.mkdir(parents=True, exist_ok=True)
        record.write_text(str(folder), encoding="utf-8")
    except OSError:
        pass


def known_install() -> Path | None:
    """Папка прошлой установки, если она ещё на месте."""
    try:
        folder = Path(memory_file().read_text(encoding="utf-8").strip())
    except OSError:
        return None
    return folder if folder.is_dir() and installed_python(folder) else None


def installed_python(folder: Path) -> Path | None:
    """Готовый Python рядом с программой, если он есть.

    Обычно это папка ``runtime``, которую делает установка. Но в папке
    разработчика её нет, зато есть ``.venv`` — и запускать надо оттуда,
    иначе разработчику каждый раз предлагают «установить» уже готовое.
    """
    runtime = folder / "runtime" / "pythonw.exe"
    if (folder / "runtime" / ".ready").exists() and runtime.exists():
        return runtime
    venv = folder / ".venv" / "Scripts" / "pythonw.exe"
    if venv.exists():
        return venv
    return None


def default_target() -> Path:
    """Куда предлагаем поставить.

    Когда рядом уже лежат файлы программы (распакованный архив), ставим
    прямо сюда — незачем плодить копию в подпапке. Когда мы одни, делаем
    свою папку, иначе программа рассыплется по «Загрузкам».
    """
    here = own_dir()
    return here if (here / "backend").is_dir() else here / APP_NAME


def system_target() -> Path:
    """Запасной вариант — личная папка программ, как у Discord или VS Code."""
    base = os.environ.get("LOCALAPPDATA") or str(Path.home())
    return Path(base) / "Programs" / APP_NAME


def child_env() -> dict[str, str]:
    """Окружение для дочерних процессов: без UTF-8 русский текст приходит мусором."""
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env


def start_app(folder: Path, extra: list[str] | None = None) -> None:
    """Открывает саму программу, передавая ей наши аргументы.

    Когда файл бросают на ярлык программы, Windows отдаёт его путь нам —
    и без передачи дальше он бы просто потерялся.
    """
    python = installed_python(folder) or folder / "runtime" / "pythonw.exe"
    subprocess.Popen(
        [str(python), str(folder / "backend" / "run.py"), "--window", *(extra or [])],
        cwd=str(folder),
        creationflags=CREATE_NO_WINDOW,
    )


class Cancelled(Exception):
    """Человек передумал: нажал «Отмена» или закрыл окно."""


class Worker:
    """Сама установка. Живёт в отдельном потоке, чтобы окно не замирало.

    Раньше всё делалось в потоке окна, и на небыстрых компьютерах Windows
    успевала объявить программу «не отвечает» — она и правда не отвечала,
    пока шла установка библиотек.
    """

    def __init__(
        self, target: Path, shortcut: bool, report: queue.Queue, update: bool = False
    ) -> None:
        self.target = target
        self.shortcut = shortcut
        self.report = report
        self.update = update
        self.stop = threading.Event()

    def say(self, text: str, percent: float | None = None) -> None:
        if self.stop.is_set():
            raise Cancelled
        self.report.put(("step", text, percent))

    # --- шаги установки --------------------------------------------------

    def copy_program(self) -> None:
        source = payload_dir()
        self.target.mkdir(parents=True, exist_ok=True)

        # Ставим в ту же папку, откуда берём, — копировать нечего.
        if source.resolve() != self.target.resolve():
            self.say("Копирую файлы программы…", 2)
            for name in ("backend", "assets", "scripts"):
                src = source / name
                if not src.exists():
                    continue
                dst = self.target / name
                if dst.exists():
                    shutil.rmtree(dst, ignore_errors=True)
                shutil.copytree(
                    src, dst, ignore=shutil.ignore_patterns("__pycache__", "*.pyc")
                )

        # Кладём рядом с программой самих себя: этот же файл будет её запускать.
        if getattr(sys, "frozen", False):
            myself = Path(sys.executable).resolve()
            destination = self.target / f"{APP_NAME}.exe"
            if myself != destination.resolve():
                shutil.copy2(myself, destination)
            # Запускалка под прежним именем больше не нужна: рядом теперь своя.
            old = self.target / f"{OLD_NAME}.exe"
            if old.exists() and old.resolve() != myself:
                with contextlib.suppress(OSError):
                    old.unlink()

    def download(self, url: str, target: Path, label: str, base: float, span: float) -> None:
        with urllib.request.urlopen(url, timeout=60) as response:
            total = int(response.headers.get("Content-Length") or 0)
            done = 0
            with target.open("wb") as handle:
                while True:
                    if self.stop.is_set():
                        raise Cancelled
                    chunk = response.read(256 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                    done += len(chunk)
                    if total:
                        share = done / total
                        self.say(f"{label} {share * 100:.0f}%", base + span * share)

    def run_quiet(self, args: list[str]) -> None:
        result = subprocess.run(
            args,
            cwd=str(self.target),
            capture_output=True,
            env=child_env(),
            creationflags=CREATE_NO_WINDOW,
        )
        if result.returncode != 0:
            tail = result.stderr.decode("utf-8", "replace").strip().splitlines()
            raise RuntimeError("\n".join(tail[-4:]) or "команда завершилась с ошибкой")

    def install_python(self) -> None:
        runtime = self.target / "runtime"
        if runtime.exists():
            shutil.rmtree(runtime, ignore_errors=True)
        runtime.mkdir(parents=True, exist_ok=True)

        archive = runtime / "python.zip"
        self.say(f"Скачиваю Python {PYTHON_VERSION}…", 5)
        self.download(PYTHON_ZIP, archive, "Скачиваю Python", 5, 15)

        self.say("Распаковываю Python…", 20)
        with zipfile.ZipFile(archive) as archive_file:
            archive_file.extractall(runtime)
        archive.unlink(missing_ok=True)

        # Встроенная сборка не видит установленные пакеты, пока не поправить ._pth.
        for pth in runtime.glob("python*._pth"):
            pth.write_text(
                pth.stem + ".zip\n.\nLib\\site-packages\n\nimport site\n",
                encoding="ascii",
            )

        python = runtime / "python.exe"

        self.say("Ставлю pip…", 24)
        getpip = runtime / "get-pip.py"
        self.download(GET_PIP, getpip, "Скачиваю pip", 24, 3)
        self.run_quiet([str(python), str(getpip), "--no-warn-script-location", "-q"])
        getpip.unlink(missing_ok=True)

        # Часть библиотек выложена без готовых «колёс» и собирается на месте.
        self.say("Готовлю сборочные инструменты…", 30)
        self.run_quiet(
            [str(python), "-m", "pip", "install", "-q", "--no-warn-script-location",
             "setuptools", "wheel"]
        )

        # --no-build-isolation обязателен: встроенный Python не видит PYTHONPATH,
        # через который pip передаёт setuptools во временное окружение сборки.
        self.say("Ставлю библиотеки и загрузчики — это самый долгий шаг…", 35)
        self.run_quiet(
            [str(python), "-m", "pip", "install", "-q", "--no-warn-script-location",
             "--no-build-isolation", "-r",
             str(self.target / "backend" / "requirements.txt")]
        )
        (runtime / ".ready").write_text("ok", encoding="ascii")

    def install_tools(self) -> None:
        self.say("Скачиваю ffmpeg и Deno…", 60)
        process = subprocess.Popen(
            [str(self.target / "runtime" / "python.exe"),
             str(self.target / "backend" / "run.py"), "--setup"],
            cwd=str(self.target),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=child_env(),
            creationflags=CREATE_NO_WINDOW,
        )
        for raw in process.stdout:
            if self.stop.is_set():
                process.kill()
                raise Cancelled
            line = raw.decode("utf-8", "replace").strip()
            if line:
                self.say(line[:90])
        if process.wait() != 0:
            raise RuntimeError(
                "Не удалось скачать ffmpeg. Проверьте интернет и попробуйте снова."
            )
        (self.target / ".sgh-tools-ok").write_text("ok", encoding="ascii")

    def make_shortcut(self) -> None:
        if not self.shortcut:
            return
        self.say("Создаю ярлык…", 96)
        exe = self.target / f"{APP_NAME}.exe"
        icon = self.target / "assets" / "icon.ico"
        desktop = Path(os.path.expanduser("~")) / "Desktop"
        # Ярлык под прежним именем вёл бы на удалённую запускалку.
        with contextlib.suppress(OSError):
            (desktop / f"{OLD_NAME}.lnk").unlink(missing_ok=True)
        command = (
            "$s = (New-Object -ComObject WScript.Shell).CreateShortcut("
            f"'{desktop / (APP_NAME + '.lnk')}'); "
            f"$s.TargetPath = '{exe}'; "
            f"$s.WorkingDirectory = '{self.target}'; "
            f"$s.IconLocation = '{icon}'; "
            "$s.Description = 'Скачивание, сжатие и простой монтаж видео, звука и картинок'; "
            "$s.Save()"
        )
        subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
            capture_output=True,
            creationflags=CREATE_NO_WINDOW,
        )

    def run(self) -> None:
        try:
            self.copy_program()
            # При обновлении Python и ffmpeg уже стоят — качать их заново
            # незачем, это те самые 250 МБ.
            if not self.update or not installed_python(self.target):
                self.install_python()
            if not self.update or not (self.target / ".sgh-tools-ok").exists():
                self.install_tools()
            if not self.update:
                self.make_shortcut()
            remember_install(self.target)
            self.say("Готово", 100)
            self.report.put(("done", None, None))
        except Cancelled:
            self.report.put(("cancelled", None, None))
        except Exception as error:  # рассказываем человеку, а не в пустоту
            self.report.put(("error", str(error), None))


class Wizard:
    """Окно установки: настройка, ход дела, итог.

    Нарисовано в цветах самой программы — тёмный фон, бирюза. Стандартные
    виджеты tkinter светлые и выглядят чужими, поэтому кнопки, переключатели
    и полоса хода дела — свои, из простых прямоугольников.
    """

    WIDTH = 520

    def __init__(self, update_target: Path | None = None) -> None:
        import tkinter as tk
        from tkinter import font as tkfont

        self.tk = tk
        self.update_target = update_target
        # Чёткий текст на экранах с увеличением: без этого Windows растягивает
        # окно картинкой, и всё мылится. Размеры ниже — через px().
        with contextlib.suppress(Exception):
            import ctypes

            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        self.root = tk.Tk()
        self.scale = max(1.0, self.root.winfo_fpixels("1i") / 96)
        self.root.title(
            f"Обновление {APP_NAME}" if update_target else f"Установка {APP_NAME}"
        )
        self.root.resizable(False, False)
        self.root.configure(bg=BG)
        # Крестик обязан останавливать работу, а не оставлять её в фоне.
        self.root.protocol("WM_DELETE_WINDOW", self.close_request)

        icon = payload_dir() / "assets" / "icon.ico"
        if icon.exists():
            with contextlib.suppress(Exception):
                self.root.iconbitmap(str(icon))
        self.logo = None
        size = 48 if self.scale < 1.25 else 72 if self.scale < 1.75 else 96
        logo = payload_dir() / "assets" / f"icon-{size}.png"
        if logo.exists():
            with contextlib.suppress(Exception):
                self.logo = tk.PhotoImage(file=str(logo))

        family = "Segoe UI Variable Text" if "Segoe UI Variable Text" in tkfont.families() else "Segoe UI"
        self.font = (family, 10)
        self.small = (family, 9)
        self.strong = (family, 10, "bold")
        self.title_font = (family, 15, "bold")

        self.frame = tk.Frame(self.root, bg=BG, padx=self.px(28), pady=self.px(24))
        self.frame.pack(fill="both", expand=True)

        self.path = tk.StringVar(value=str(default_target()))
        self.here = tk.BooleanVar(value=True)
        self.want_shortcut = tk.BooleanVar(value=True)
        self.want_open = tk.BooleanVar(value=True)
        self.path_entry = None
        self.browse_button = None

        self.queue: queue.Queue = queue.Queue()
        self.worker: Worker | None = None
        self.status = None
        self.bar = None
        self.working = False

        if update_target:
            self.show_update()
        else:
            self.show_setup()
        self.dark_title()
        self.center()

    # --- оформление -----------------------------------------------------

    def px(self, value: float) -> int:
        """Размер с поправкой на увеличение экрана."""
        return round(value * self.scale)

    def dark_title(self) -> None:
        """Тёмная полоса заголовка, как у самой программы (Windows 10 20H1+)."""
        with contextlib.suppress(Exception):
            import ctypes

            self.root.update_idletasks()
            hwnd = ctypes.windll.user32.GetParent(self.root.winfo_id())
            value = ctypes.c_int(1)
            # 20 — DWMWA_USE_IMMERSIVE_DARK_MODE.
            ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, 20, ctypes.byref(value), ctypes.sizeof(value))

    def header(self, title: str, subtitle: str) -> None:
        tk = self.tk
        row = tk.Frame(self.frame, bg=BG)
        row.pack(fill="x", pady=(0, self.px(20)))
        if self.logo is not None:
            tk.Label(row, image=self.logo, bg=BG).pack(side="left", padx=(0, self.px(14)))
        text = tk.Frame(row, bg=BG)
        text.pack(side="left", fill="x")
        tk.Label(text, text=title, font=self.title_font, fg=INK, bg=BG).pack(anchor="w")
        tk.Label(
            text, text=subtitle, font=self.font, fg=INK_DIM, bg=BG,
            justify="left", wraplength=self.px(self.WIDTH - 50),
        ).pack(anchor="w")

    def note(self, parent, text: str, color: str = INK_FAINT, pady=(0, 0)) -> None:
        self.tk.Label(
            parent, text=text, font=self.small, fg=color, bg=parent["bg"],
            justify="left", wraplength=self.px(self.WIDTH),
        ).pack(anchor="w", pady=tuple(self.px(v) for v in pady))

    def card(self, pady=(0, 16)):
        """Плашка-раздел: чуть светлее фона, как карточки в правой колонке."""
        box = self.tk.Frame(self.frame, bg=SURFACE, padx=self.px(16), pady=self.px(12),
                            highlightthickness=1, highlightbackground=LINE_SOFT)
        box.pack(fill="x", pady=tuple(self.px(v) for v in pady))
        return box

    def button(self, parent, text: str, command, primary: bool = False, side: str = "right"):
        """Кнопка из надписи: стандартная ttk-кнопка на тёмном фоне — белое пятно."""
        tk = self.tk
        normal = ACCENT_STRONG if primary else SURFACE_3
        hover = ACCENT if primary else LINE
        label = tk.Label(
            parent, text=text, font=self.strong if primary else self.font,
            fg=INK, bg=normal, padx=self.px(18), pady=self.px(7), cursor="hand2",
        )
        state = {"on": True}

        def enable(on: bool) -> None:
            state["on"] = on
            label.config(fg=INK if on else INK_FAINT, bg=normal if on else SURFACE_2,
                         cursor="hand2" if on else "arrow")

        label.bind("<Enter>", lambda _e: state["on"] and label.config(bg=hover))
        label.bind("<Leave>", lambda _e: state["on"] and label.config(bg=normal))
        label.bind("<ButtonRelease-1>", lambda _e: state["on"] and command())
        label.enable = enable
        label.pack(side=side, padx=(self.px(8), 0) if side == "right" else (0, self.px(8)))
        return label

    def toggle(self, parent, text: str, variable, command=None) -> None:
        """Переключатель как в программе: бирюзовый, когда включён."""
        tk = self.tk
        row = tk.Frame(parent, bg=parent["bg"], cursor="hand2")
        row.pack(anchor="w", fill="x", pady=self.px(3))
        u = self.px
        canvas = tk.Canvas(row, width=u(34), height=u(18), bg=parent["bg"], highlightthickness=0,
                           cursor="hand2")
        canvas.pack(side="left")
        label = tk.Label(row, text=text, font=self.font, fg=INK, bg=parent["bg"], cursor="hand2")
        label.pack(side="left", padx=(u(10), 0))

        def draw(*_args) -> None:
            canvas.delete("all")
            on = variable.get()
            fill = ACCENT if on else LINE
            # Капсула из двух кругов и прямоугольника: у Canvas нет скруглений.
            canvas.create_oval(u(1), u(1), u(17), u(17), fill=fill, outline=fill)
            canvas.create_oval(u(17), u(1), u(33), u(17), fill=fill, outline=fill)
            canvas.create_rectangle(u(9), u(1), u(25), u(17), fill=fill, outline=fill)
            x = 19 if on else 3
            canvas.create_oval(u(x), u(3), u(x + 12), u(15), fill=INK, outline=INK)

        def flip(_event=None) -> None:
            variable.set(not variable.get())
            if command:
                command()

        for widget in (row, canvas, label):
            widget.bind("<ButtonRelease-1>", flip)
        # Перерисовка по самой переменной: её меняют и не нажатием.
        trace = variable.trace_add("write", draw)
        canvas.bind("<Destroy>", lambda _e: variable.trace_remove("write", trace))
        draw()

    def footer(self):
        row = self.tk.Frame(self.frame, bg=BG)
        row.pack(fill="x", pady=(self.px(4), 0))
        return row

    def center(self) -> None:
        self.root.update_idletasks()
        width, height = self.root.winfo_width(), self.root.winfo_height()
        x = (self.root.winfo_screenwidth() - width) // 2
        y = (self.root.winfo_screenheight() - height) // 3
        self.root.geometry(f"+{x}+{y}")

    def clear(self) -> None:
        for child in self.frame.winfo_children():
            child.destroy()
        # Распорка: окно одной ширины на всех экранах, а не по самой длинной строке.
        self.tk.Frame(self.frame, width=self.px(self.WIDTH), height=0, bg=BG).pack()

    def close_request(self) -> None:
        """Крестик: во время установки спрашиваем, иначе просто уходим."""
        if not self.working:
            self.root.destroy()
            return
        from tkinter import messagebox

        if messagebox.askyesno(APP_NAME, "Прервать установку?"):
            self.cancel()

    # --- страница 1: настройка ------------------------------------------

    def show_update(self) -> None:
        """Экран для тех, у кого программа уже стоит."""
        self.clear()
        target = self.update_target
        if target is None:
            self.show_setup()
            return

        self.header(
            "Обновление",
            f"Установлена версия {read_version(target) or 'неизвестная'}, "
            f"этот файл принёс {payload_version() or 'новую'}.",
        )

        box = self.card()
        self.note(box, "Папка программы", pady=(0, 2))
        self.tk.Label(box, text=str(target), font=self.font, fg=INK, bg=SURFACE,
                      justify="left", wraplength=self.px(self.WIDTH - 40)).pack(anchor="w")

        self.note(
            self.frame,
            "Обновятся только файлы программы. Python, ffmpeg и загрузчики останутся "
            "на месте — скачивать их заново не придётся. Настройки и скачанные файлы "
            "не трогаются.",
            pady=(0, 14),
        )
        self.toggle(self.frame, "Открыть программу после обновления", self.want_open)

        buttons = self.footer()
        buttons.pack_configure(pady=(self.px(18), 0))
        self.button(buttons, "Отмена", self.root.destroy)
        self.button(buttons, "Обновить", self.start_update, primary=True)
        # Запасной выход: поставить свежую копию отдельно, ничего не трогая.
        self.button(buttons, "Установить отдельно…", self.show_setup, side="left")

    def start_update(self) -> None:
        """Обновление отличается от установки только пропуском тяжёлых шагов."""
        target = self.update_target
        if target is None:
            return
        self.show_progress("Обновляю")
        self.working = True
        self.worker = Worker(target, False, self.queue, update=True)
        threading.Thread(target=self.worker.run, name="update", daemon=True).start()
        self.root.after(100, self.pump)

    def show_setup(self) -> None:
        tk = self.tk
        self.clear()

        self.header(APP_NAME, "Скачивание, сжатие и простой монтаж видео, звука и картинок.")

        box = self.card()
        self.toggle(box, "Установить туда же, где лежит этот файл", self.here, self.toggle_place)
        row = tk.Frame(box, bg=SURFACE)
        row.pack(fill="x", pady=(self.px(8), self.px(2)))
        self.path_entry = tk.Entry(
            row, textvariable=self.path, font=self.font, relief="flat",
            bg=SURFACE_2, fg=INK, insertbackground=INK,
            disabledbackground=SURFACE_2, disabledforeground=INK_FAINT,
            highlightthickness=1, highlightbackground=LINE, highlightcolor=ACCENT,
        )
        self.path_entry.pack(side="left", fill="x", expand=True, ipady=self.px(5), ipadx=self.px(6))
        self.browse_button = self.button(row, "Обзор…", self.choose)
        self.browse_button.config(pady=self.px(5), padx=self.px(12))
        self.toggle_place()

        options = self.card()
        self.toggle(options, "Создать ярлык на рабочем столе", self.want_shortcut)
        self.toggle(options, "Открыть программу после установки", self.want_open)

        self.note(
            self.frame,
            "Во время установки программа скачает то, что ей нужно для работы: "
            "Python, ffmpeg и загрузчики — около 250 МБ. Это делается один раз.",
            pady=(0, 18),
        )

        buttons = self.footer()
        self.button(buttons, "Отмена", self.root.destroy)
        self.button(buttons, "Установить", self.start, primary=True)

    def toggle_place(self) -> None:
        """Поле пути живёт, только когда человек снял галочку."""
        if self.here.get():
            self.path.set(str(default_target()))
            on = False
        else:
            self.path.set(str(system_target()))
            on = True
        self.path_entry.config(state="normal" if on else "disabled")
        self.browse_button.enable(on)

    def choose(self) -> None:
        from tkinter import filedialog

        picked = filedialog.askdirectory(title="Куда установить программу")
        if picked:
            self.path.set(str(Path(picked) / APP_NAME))

    # --- страница 2: ход дела -------------------------------------------

    def show_progress(self, title: str = "Устанавливаю") -> None:
        tk = self.tk
        self.clear()

        self.header(
            title,
            "Можно свернуть окно — программа сообщит, когда закончит.",
        )

        self.bar = tk.Canvas(self.frame, width=self.px(self.WIDTH), height=self.px(6), bg=SURFACE_3,
                             highlightthickness=0)
        self.bar.pack(fill="x")
        self.bar_fill = self.bar.create_rectangle(0, 0, 0, self.px(6), fill=ACCENT, outline=ACCENT)
        self.status = tk.Label(self.frame, text="Начинаю…", font=self.font, fg=INK_DIM, bg=BG,
                               justify="left", wraplength=self.px(self.WIDTH), anchor="w")
        self.status.pack(anchor="w", fill="x", pady=(self.px(10), self.px(18)))

        buttons = self.footer()
        self.button(buttons, "Отмена", self.cancel)

    def set_progress(self, percent: float) -> None:
        width = self.bar.winfo_width() or self.px(self.WIDTH)
        self.bar.coords(self.bar_fill, 0, 0, width * max(0.0, min(percent, 100.0)) / 100, self.px(6))

    def start(self) -> None:
        from tkinter import messagebox

        target = Path(self.path.get().strip())
        if not target.name:
            messagebox.showerror(APP_NAME, "Укажите папку для установки.")
            return
        try:
            target.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            messagebox.showerror(APP_NAME, f"Не получается создать папку:\n{error}")
            return

        self.show_progress()
        self.working = True
        self.worker = Worker(target, self.want_shortcut.get(), self.queue)
        threading.Thread(target=self.worker.run, name="install", daemon=True).start()
        self.root.after(100, self.pump)

    def cancel(self) -> None:
        if self.worker:
            self.worker.stop.set()
        if self.status:
            self.status.config(text="Останавливаю…")

    def pump(self) -> None:
        """Забирает сообщения от рабочего потока. Окно всё это время живое."""
        try:
            while True:
                kind, text, percent = self.queue.get_nowait()
                if kind == "step":
                    if text:
                        self.status.config(text=text)
                    if percent is not None:
                        self.set_progress(percent)
                elif kind == "done":
                    self.working = False
                    self.show_done()
                    return
                elif kind == "cancelled":
                    self.working = False
                    self.root.destroy()
                    return
                elif kind == "error":
                    self.working = False
                    self.show_error(text or "")
                    return
        except queue.Empty:
            pass
        self.root.after(100, self.pump)

    # --- страница 3: итог ------------------------------------------------

    def show_done(self) -> None:
        self.clear()
        updated = bool(self.worker and self.worker.update)
        self.header("Готово", f"{APP_NAME} {'обновлён' if updated else 'установлен'}.")

        box = self.card(pady=(0, 18))
        self.note(box, "Папка программы", pady=(0, 2))
        self.tk.Label(box, text=str(self.worker.target if self.worker else ""), font=self.font,
                      fg=INK, bg=SURFACE, justify="left", wraplength=self.px(self.WIDTH - 40)).pack(anchor="w")

        buttons = self.footer()
        self.button(buttons, "Открыть программу" if self.want_open.get() else "Закрыть",
                    self.finish, primary=True)
        self.center()

    def show_error(self, text: str) -> None:
        self.clear()
        self.header("Установка не завершилась",
                    "Чаще всего это интернет или антивирус. Проверьте соединение "
                    "и запустите установку ещё раз.")

        box = self.card(pady=(0, 18))
        self.tk.Label(box, text=text, font=self.small, fg=DANGER, bg=SURFACE,
                      justify="left", wraplength=self.px(self.WIDTH - 40)).pack(anchor="w")

        buttons = self.footer()
        self.button(buttons, "Закрыть", self.root.destroy)
        self.center()

    def finish(self) -> None:
        if self.want_open.get() and self.worker:
            start_app(self.worker.target)
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


def needs_update(folder: Path) -> bool:
    """Принёс ли этот файл версию, отличную от установленной."""
    here, there = payload_version(), read_version(folder)
    return bool(here and there and here != there)


def main() -> int:
    fresh = payload_version()

    # Программа уже стоит рядом. Обычно это значит, что нас позвали ярлыком —
    # но если версии разошлись, человек принёс сюда новый файл, чтобы
    # обновиться, и запускать старую программу было бы издевательством.
    if installed_python(own_dir()):
        if needs_update(own_dir()):
            Wizard(update_target=own_dir()).run()
            return 0
        remember_install(own_dir())
        # Пути файлов, брошенных на ярлык, передаём программе как есть.
        start_app(own_dir(), [arg for arg in sys.argv[1:] if not arg.startswith("-")])
        return 0

    # Рядом ничего нет — но программа может стоять в другом месте. Тогда
    # предлагаем обновить её, а не ставить второй раз и качать всё заново.
    previous = known_install()
    if previous and fresh and needs_update(previous):
        Wizard(update_target=previous).run()
        return 0

    Wizard().run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
