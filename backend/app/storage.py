"""파일 저장 경로 관리. 업로드 파일명은 경로로 쓰지 않고 UUID 로만 저장한다."""
from __future__ import annotations

import re
import unicodedata
from pathlib import Path

import numpy as np
from PIL import Image

_ID_RE = re.compile(r"^[0-9a-f]{32}$")
Image.MAX_IMAGE_PIXELS = None   # 서버가 직접 만든 이미지(대형 도면)만 다시 연다


class Storage:
    def __init__(self, root: Path) -> None:
        self.root = root
        for d in ("uploads", "comparisons", "exports", "tmp"):
            (root / d).mkdir(parents=True, exist_ok=True)

    @staticmethod
    def check_id(value: str) -> str:
        if not _ID_RE.match(value):
            raise ValueError("잘못된 ID 형식")
        return value

    def upload_path(self, doc_id: str) -> Path:
        return self.root / "uploads" / f"{self.check_id(doc_id)}.pdf"

    def tmp_dir(self) -> Path:
        return self.root / "tmp"

    def comparison_dir(self, cid: str) -> Path:
        return self.root / "comparisons" / self.check_id(cid)

    def page_dir(self, cid: str, page: int) -> Path:
        if page < 0:
            raise ValueError("페이지 번호 오류")
        return self.comparison_dir(cid) / f"page_{page:04d}"

    def export_path(self, eid: str, suffix: str) -> Path:
        if suffix not in (".pdf", ".json"):
            raise ValueError("허용되지 않는 확장자")
        return self.root / "exports" / f"{self.check_id(eid)}{suffix}"


def sanitize_display_name(name: str | None) -> str:
    """화면·다운로드 이름용. 디렉터리 성분과 제어문자를 제거한다 (저장 경로에는 사용하지 않음)."""
    base = (name or "").replace("\\", "/").split("/")[-1]
    base = unicodedata.normalize("NFC", base)
    base = "".join(ch for ch in base if unicodedata.category(ch)[0] != "C").strip().strip(".")
    return (base or "document.pdf")[:255]


def save_mask_png(mask: np.ndarray, path: Path) -> None:
    Image.fromarray(np.ascontiguousarray(mask, dtype=bool)).save(path, format="PNG", optimize=False)


def load_mask_png(path: Path) -> np.ndarray:
    with Image.open(path) as im:
        if im.mode != "1":
            raise ValueError(f"마스크 PNG 형식 오류: {im.mode}")
        raw = np.array(im)
    # PIL 의 mode "1" 배열은 True 바이트가 0xFF 로 들어온다. 엔진 마스크(0x01)와 바이트까지 같도록 정규화
    # (정규화하지 않으면 ~mask 연산 결과가 달라질 수 있음 – v0.2 에서 SHA 검사로 발견)
    return raw.view(np.uint8) != 0


def save_rgb_png(arr: np.ndarray, path: Path) -> None:
    Image.fromarray(arr).save(path, format="PNG", compress_level=1)


def load_rgb_png(path: Path) -> np.ndarray:
    with Image.open(path) as im:
        return np.array(im.convert("RGB"))
