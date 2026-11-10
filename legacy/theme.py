# -*- coding: utf-8 -*-
"""UI theme module for Drawing Auto Comparison.

Place this file in the same directory as:
    compare_drawings_overlay_gui5_markup_v10.py

Optional bundled fonts:
    fonts/Pretendard-Regular.otf
    fonts/Pretendard-Bold.otf
    fonts/Pretendard-ExtraBold.otf

If Pretendard cannot be registered, the module falls back to Malgun Gothic
(on Windows) or a Tk/system font.
"""

from __future__ import annotations

import os
import sys

# ---------------------------------------------------------------------------
# Palette required by the main program
# ---------------------------------------------------------------------------
# Neutral graphite (no blue cast) so the drawing is the only colourful thing on screen.
# All text/background pairs below are >= 4.5:1 (WCAG AA).
BG = "#121417"                  # main window background
PANEL = "#16181C"               # menus / panels
CARD = "#1E2126"                # cards / inactive buttons
BORDER = "#2B2F36"              # borders / title bars
FG = "#E6E8EB"                  # primary foreground
FG2 = "#8A919B"                 # secondary foreground
VIEWBG = "#2A2D33"              # canvas outside page: dark so the white sheet stands out
LOADED_BG = "#1A2638"           # loaded-file card background (accent tint)

C_BLUE = "#2B6CE8"              # primary accent
C_ORANGE = "#B45309"
C_GREEN = "#15803D"
C_PURPLE = "#7044D6"
C_RED = "#E5484D"

BUBBLE_FILL = "#FFD33D"
BUBBLE_EDGE = "#8A5A00"
HILITE = "#FF2D55"
OLD_FRAME = "#5B626C"
NEW_FRAME = C_BLUE
CARD_REGION_COLOR = "#FFB000"
WARN_FG = "#F0A04B"

# Text colors referenced as T.TXT_*
TXT_TITLE = "#F5F6F8"
TXT_SECTION = "#8A919B"         # muted caps headers, like pro tools' panel labels
TXT_BODY = "#B4BAC2"
TXT_HINT = "#7D8590"
TXT_BUTTON = "#FFFFFF"
TXT_TOOLBAR = "#B4BAC2"

# Four shades used by SlideMenu's right-side shadow strip.
MENU_SHADOW = ("#30343B", "#24272D", "#1A1C20", "#121417")

# ---------------------------------------------------------------------------
# Font state required by the main program
# ---------------------------------------------------------------------------
FONT_FAMILY = "Malgun Gothic" if sys.platform.startswith("win") else "TkDefaultFont"
FONT_NOTE = ""

# These are initialized by init_fonts(). Tuple defaults allow module import and
# limited widget construction even if init_fonts() has not run yet.
F_TITLE = (FONT_FAMILY, 14, "bold")
F_SECTION = (FONT_FAMILY, 9, "bold")
F_BODY = (FONT_FAMILY, 10)
F_HINT = (FONT_FAMILY, 9)
F_BUTTON = (FONT_FAMILY, 10, "bold")
F_TOOLBAR = (FONT_FAMILY, 10)


def _base_dir() -> str:
    """Return the application directory, including frozen-app compatibility."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    main_file = getattr(sys.modules.get("__main__"), "__file__", None)
    if main_file:
        return os.path.dirname(os.path.abspath(main_file))
    return os.path.dirname(os.path.abspath(__file__))


def register_private_fonts() -> bool:
    """Register bundled Pretendard fonts for this process on Windows.

    Must be called before creating the Tk root. Returns True if at least one
    font file was registered. Failure is non-fatal and causes fallback fonts.
    """
    global FONT_NOTE

    font_dir = os.path.join(_base_dir(), "fonts")
    names = (
        "Pretendard-Regular.otf",
        "Pretendard-Bold.otf",
        "Pretendard-ExtraBold.otf",
    )
    paths = [os.path.join(font_dir, name) for name in names]
    existing = [path for path in paths if os.path.isfile(path)]

    if not existing:
        FONT_NOTE = "Pretendard 글꼴 파일이 없어 시스템 글꼴을 사용합니다."
        return False

    if not sys.platform.startswith("win"):
        FONT_NOTE = "현재 운영체제에서는 사설 Pretendard 등록을 생략하고 시스템 글꼴을 사용합니다."
        return False

    try:
        import ctypes

        FR_PRIVATE = 0x10
        add_font = ctypes.windll.gdi32.AddFontResourceExW
        registered = 0
        for path in existing:
            try:
                if add_font(path, FR_PRIVATE, 0) > 0:
                    registered += 1
            except Exception:
                pass

        if registered:
            FONT_NOTE = "" if registered == len(paths) else f"Pretendard 글꼴 {registered}/{len(paths)}개를 등록했습니다."
            return True

        FONT_NOTE = "Pretendard 글꼴을 등록하지 못해 시스템 글꼴을 사용합니다."
        return False
    except Exception as exc:
        FONT_NOTE = f"Pretendard 글꼴 등록 실패로 시스템 글꼴을 사용합니다: {exc}"
        return False


def _available_families(root) -> set[str]:
    try:
        import tkinter.font as tkfont
        return {str(name).casefold() for name in tkfont.families(root)}
    except Exception:
        return set()


def init_fonts(root, private_registered: bool = False) -> None:
    """Create all Tk font objects expected by the main application.

    Call after Tk() has been created. The objects are intentionally stored in
    module globals because the main program accesses them as T.F_*.
    """
    global FONT_FAMILY, FONT_NOTE
    global F_TITLE, F_SECTION, F_BODY, F_HINT, F_BUTTON, F_TOOLBAR

    import tkinter.font as tkfont

    families = _available_families(root)
    candidates = []
    if private_registered:
        candidates.extend(("Pretendard", "Pretendard Regular"))
    if sys.platform.startswith("win"):
        candidates.extend(("Malgun Gothic", "맑은 고딕", "Segoe UI"))
    elif sys.platform == "darwin":
        candidates.extend(("Apple SD Gothic Neo", "Arial"))
    else:
        candidates.extend(("Noto Sans CJK KR", "Noto Sans KR", "DejaVu Sans"))

    family = next((name for name in candidates if name.casefold() in families), None)
    if family is None:
        try:
            family = tkfont.nametofont("TkDefaultFont").actual("family")
        except Exception:
            family = "TkDefaultFont"

    FONT_FAMILY = family
    if private_registered and not family.casefold().startswith("pretendard"):
        FONT_NOTE = "Pretendard가 등록되었지만 Tk에서 찾지 못해 시스템 글꼴을 사용합니다."

    # Named Font objects remain alive for the duration of the Tk application.
    F_TITLE = tkfont.Font(root=root, family=family, size=14, weight="bold")
    F_SECTION = tkfont.Font(root=root, family=family, size=9, weight="bold")
    F_BODY = tkfont.Font(root=root, family=family, size=10)
    F_HINT = tkfont.Font(root=root, family=family, size=9)
    F_BUTTON = tkfont.Font(root=root, family=family, size=10, weight="bold")
    F_TOOLBAR = tkfont.Font(root=root, family=family, size=10)


__all__ = [
    "BG", "PANEL", "CARD", "BORDER", "FG", "FG2", "VIEWBG", "LOADED_BG",
    "C_BLUE", "C_ORANGE", "C_GREEN", "C_PURPLE", "C_RED",
    "BUBBLE_FILL", "BUBBLE_EDGE", "HILITE", "OLD_FRAME", "NEW_FRAME",
    "CARD_REGION_COLOR", "WARN_FG", "TXT_TITLE", "TXT_SECTION", "TXT_BODY",
    "TXT_HINT", "TXT_BUTTON", "TXT_TOOLBAR", "MENU_SHADOW", "FONT_FAMILY",
    "FONT_NOTE", "F_TITLE", "F_SECTION", "F_BODY", "F_HINT", "F_BUTTON",
    "F_TOOLBAR", "register_private_fonts", "init_fonts",
]
