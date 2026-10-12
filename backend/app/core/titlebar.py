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

import ctypes
import logging
import sys
from ctypes import wintypes
from typing import Any, Callable

log = logging.getLogger("sigame-helper")

WM_NCCALCSIZE = 0x0083
WM_NCLBUTTONDOWN = 0x00A1
WM_SYSCOMMAND = 0x0112
HTCAPTION = 2
HTTOP = 12
SC_MINIMIZE = 0xF020
SC_MAXIMIZE = 0xF030
SC_RESTORE = 0xF120
SC_CLOSE = 0xF060
GWLP_WNDPROC = -4
SM_CYFRAME = 33
SM_CXPADDEDBORDER = 92
SWP_FLAGS = 0x0001 | 0x0002 | 0x0004 | 0x0020  # NOSIZE | NOMOVE | NOZORDER | FRAMECHANGED

#: Окно, которому заменили заголовок, и как исполнять код в его потоке.
_hwnd = 0
_invoke: Callable[[Callable[[], None]], None] | None = None
#: Ссылки держим, иначе сборщик мусора уберёт обработчик из-под окна.
_keep: list[Any] = []


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
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    return user32


def install(hwnd: int, invoke: Callable[[Callable[[], None]], None]) -> bool:
    """Убирает системную строку заголовка у окна ``hwnd``.

    ``invoke`` исполняет функцию в потоке окна: подменять обработку
    сообщений и начинать перетаскивание надо оттуда.
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
        if message == WM_NCCALCSIZE and wparam:
            params = ctypes.cast(lparam, ctypes.POINTER(_NCCALCSIZE_PARAMS)).contents
            top = params.rgrc[0].top
            result = user32.CallWindowProcW(original[0], window, message, wparam, lparam)
            # Всё как у обычной рамки, кроме верха: там была строка заголовка.
            # Развёрнутое окно Windows выносит за край экрана на толщину
            # рамки — сверху её надо вернуть, иначе срежется наша панель.
            frame = 0
            if user32.IsZoomed(window):
                frame = user32.GetSystemMetrics(SM_CYFRAME) + user32.GetSystemMetrics(SM_CXPADDEDBORDER)
            params.rgrc[0].top = top + frame
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
