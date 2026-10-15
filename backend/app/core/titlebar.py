"""Своя строка заголовка окна вместо системной (только Windows).

Системная строка — белая полоса над тёмным окном, да ещё и лишние тридцать
пунктов высоты. Убирать её «рамку целиком» нельзя: окно без рамки не
тянется за края, не прилипает к краям экрана и не разворачивается двойным
нажатием. Поэтому рамку оставляем, а убираем только строку заголовка: окну
подменяется обработка ``WM_NCCALCSIZE``, и его страница начинается с самого
верха. Остальную рамку Windows считает и рисует как обычно — края тянутся,
окно прилипает и сворачивается.

Таскают окно за нашу верхнюю панель: страница сообщает о нажатии, и окно
получает обычное «нажали на заголовок» (``WM_NCLBUTTONDOWN``), дальше всё
делает Windows — с прилипанием к краям и разворачиванием на весь экран.
Верхний край, которого больше нет, тянут так же — с ``HTTOP``.

Если подмена не удалась, остаётся обычная системная строка, а страница
своих кнопок окна не рисует (``state()``).
"""

from __future__ import annotations

import contextlib
import ctypes
import logging
import sys
from ctypes import wintypes
from typing import Any, Callable

log = logging.getLogger("sigame-helper")

WM_NCCALCSIZE = 0x0083
WM_GETMINMAXINFO = 0x0024
WM_NCLBUTTONDOWN = 0x00A1
WM_SYSCOMMAND = 0x0112
HTCAPTION = 2
HTTOP = 12
SC_MINIMIZE = 0xF020
SC_MAXIMIZE = 0xF030
SC_RESTORE = 0xF120
SC_CLOSE = 0xF060
GWLP_WNDPROC = -4
SWP_FLAGS = 0x0001 | 0x0002 | 0x0004 | 0x0020  # NOSIZE | NOMOVE | NOZORDER | FRAMECHANGED

#: Окно, которому заменили заголовок, и как исполнять код в его потоке.
_hwnd = 0
_invoke: Callable[[Callable[[], None]], None] | None = None
#: Ссылки держим, иначе сборщик мусора уберёт обработчик из-под окна.
_keep: list[Any] = []


MONITOR_DEFAULTTONEAREST = 2


class _MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", wintypes.RECT),
        ("rcWork", wintypes.RECT),
        ("dwFlags", wintypes.DWORD),
    ]


class _MINMAXINFO(ctypes.Structure):
    _fields_ = [
        ("ptReserved", wintypes.POINT),
        ("ptMaxSize", wintypes.POINT),
        ("ptMaxPosition", wintypes.POINT),
        ("ptMinTrackSize", wintypes.POINT),
        ("ptMaxTrackSize", wintypes.POINT),
    ]


class _NCCALCSIZE_PARAMS(ctypes.Structure):
    _fields_ = [("rgrc", wintypes.RECT * 3), ("lppos", ctypes.c_void_p)]


def _user32():
    user32 = ctypes.windll.user32
    user32.SetWindowLongPtrW.restype = ctypes.c_void_p
    user32.SetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_void_p]
    user32.CallWindowProcW.restype = ctypes.c_ssize_t
    user32.CallWindowProcW.argtypes = [
        ctypes.c_void_p, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
    ]
    user32.MonitorFromWindow.restype = ctypes.c_void_p
    user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
    user32.MonitorFromRect.restype = ctypes.c_void_p
    user32.MonitorFromRect.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    user32.GetMonitorInfoW.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    return user32


def install(
    hwnd: int,
    invoke: Callable[[Callable[[], None]], None],
    minimum: tuple[int, int] | None = None,
) -> bool:
    """Убирает системную строку заголовка у окна ``hwnd``.

    ``invoke`` исполняет функцию в потоке окна: подменять обработку
    сообщений и начинать перетаскивание надо оттуда. ``minimum`` —
    наименьший размер окна в точках интерфейса: его переводим в точки
    экрана по масштабу того монитора, где окно стоит сейчас. Сама форма
    считает его один раз, при открытии, — и на мониторе с другим масштабом
    окно не сжималось до нужного (при 100% после 125% — 1437 точек вместо
    1150).
    """
    global _hwnd, _invoke
    if sys.platform != "win32" or not hwnd:
        return False
    user32 = _user32()
    WNDPROC = ctypes.WINFUNCTYPE(
        ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
    )
    original: list[int] = [0]

    def procedure(window, message, wparam, lparam):
        if message == WM_GETMINMAXINFO and minimum:
            result = user32.CallWindowProcW(original[0], window, message, wparam, lparam)
            # Масштаб монитора, на котором окно сейчас (большей частью), а не
            # окна: окно узнаёт о переезде позже, чем его уже тянут.
            dpi_x, dpi_y = ctypes.c_uint(96), ctypes.c_uint(96)
            with contextlib.suppress(Exception):
                ctypes.windll.shcore.GetDpiForMonitor(
                    ctypes.c_void_p(user32.MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST)),
                    0, ctypes.byref(dpi_x), ctypes.byref(dpi_y),
                )
            scale = (dpi_x.value or 96) / 96
            info = ctypes.cast(lparam, ctypes.POINTER(_MINMAXINFO)).contents
            info.ptMinTrackSize.x = round(minimum[0] * scale)
            info.ptMinTrackSize.y = round(minimum[1] * scale)
            return result
        if message == WM_NCCALCSIZE and wparam:
            params = ctypes.cast(lparam, ctypes.POINTER(_NCCALCSIZE_PARAMS)).contents
            top = params.rgrc[0].top
            # Куда окно встанет — до обработки, пока это ещё прямоугольник окна.
            proposed = wintypes.RECT(
                params.rgrc[0].left, params.rgrc[0].top, params.rgrc[0].right, params.rgrc[0].bottom
            )
            result = user32.CallWindowProcW(original[0], window, message, wparam, lparam)
            if user32.IsZoomed(window):
                # Развёрнутое окно Windows выносит за край экрана на толщину
                # рамки, а толщина у каждого монитора своя (разный масштаб):
                # считая её по главному, на втором мониторе получали белые
                # полосы по краям. Поэтому страница занимает ровно рабочую
                # область того монитора, куда окно встаёт.
                #
                # Монитор — по новому месту окна, а не по нынешнему: свёрнутое
                # окно Windows держит на −32000, и при возврате из свёрнутого
                # «ближайшим» оказывался монитор слева — страница уезжала на
                # него, а развёрнутое окно оставалось белым.
                monitor = user32.MonitorFromRect(ctypes.byref(proposed), MONITOR_DEFAULTTONEAREST)
                info = _MONITORINFO()
                info.cbSize = ctypes.sizeof(_MONITORINFO)
                found = user32.GetMonitorInfoW(monitor, ctypes.byref(info))
                work = info.rcWork
                # Только если окно и правда накрывает рабочую область. Развёрнутое
                # окно, которое передвинули программно, остаётся «развёрнутым»,
                # но стоит в стороне — страница должна остаться в нём.
                if (
                    found
                    and proposed.left <= work.left
                    and proposed.top <= work.top
                    and proposed.right >= work.right
                    and proposed.bottom >= work.bottom
                ):
                    params.rgrc[0] = info.rcWork
                    return result
            # Всё как у обычной рамки, кроме верха: там была строка заголовка.
            params.rgrc[0].top = top
            return result
        return user32.CallWindowProcW(original[0], window, message, wparam, lparam)

    callback = WNDPROC(procedure)
    done: list[bool] = [False]

    def attach() -> None:
        previous = user32.SetWindowLongPtrW(hwnd, GWLP_WNDPROC, ctypes.cast(callback, ctypes.c_void_p))
        if not previous:
            return
        original[0] = previous
        user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_FLAGS)
        done[0] = True

    try:
        invoke(attach)
    except Exception:
        log.warning("свою строку заголовка поставить не удалось", exc_info=True)
        return False
    if not done[0]:
        log.warning("свою строку заголовка поставить не удалось: окно не приняло обработчик")
        return False
    _keep.extend([callback, procedure])
    _hwnd, _invoke = hwnd, invoke
    log.info("системная строка заголовка заменена своей")
    return True


def state() -> dict[str, bool]:
    """Своя ли строка заголовка и развёрнуто ли окно."""
    if not _hwnd:
        return {"custom": False, "maximized": False}
    return {"custom": True, "maximized": bool(ctypes.windll.user32.IsZoomed(_hwnd))}


def act(action: str) -> bool:
    """Кнопки и перетаскивание окна со страницы."""
    if not _hwnd or _invoke is None:
        return False
    user32 = _user32()
    hwnd = _hwnd

    def run() -> None:
        if action in {"drag", "resize-top"}:
            # Кнопка мыши ещё зажата над страницей: отпускаем её захват и
            # говорим окну, что нажали на заголовок (или верхний край) — дальше
            # перетаскивание ведёт Windows, с прилипанием к краям экрана.
            user32.ReleaseCapture()
            hit = HTCAPTION if action == "drag" else HTTOP
            user32.PostMessageW(hwnd, WM_NCLBUTTONDOWN, hit, 0)
        elif action == "minimize":
            user32.PostMessageW(hwnd, WM_SYSCOMMAND, SC_MINIMIZE, 0)
        elif action == "maximize":
            command = SC_RESTORE if user32.IsZoomed(hwnd) else SC_MAXIMIZE
            user32.PostMessageW(hwnd, WM_SYSCOMMAND, command, 0)
        elif action == "close":
            user32.PostMessageW(hwnd, WM_SYSCOMMAND, SC_CLOSE, 0)

    _invoke(run)
    return True
