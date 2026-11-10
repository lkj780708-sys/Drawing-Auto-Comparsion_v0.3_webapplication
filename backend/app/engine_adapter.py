"""엔진(legacy_v10) 호출 Adapter.

- 비교·정렬·검출·AI 검증 로직은 engine/legacy_v10.py 를 그대로 호출만 한다.
- 이 파일: 엔진 상수 스냅샷, 정렬 상태 라벨(사용자 승인 기준), 저장 결과로 엔진 객체 재구성, 단위 변환.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

from engine import legacy_v10 as E

ENGINE_DIR = Path(__file__).resolve().parents[1] / "engine"
_VERSION = json.loads((ENGINE_DIR / "VERSION.json").read_text(encoding="utf-8"))
_EXTRACT_SHA = hashlib.sha256((ENGINE_DIR / "legacy_v10.py").read_bytes()).hexdigest()

# ------------------------------------------------------------------ 정렬 상태 (2026-11-09 사용자 승인 기준)
ALIGN_OK_MIN_IOU = 0.80
ALIGN_FAIL_MAX_IOU = 0.30
ALIGNMENT_RULE_TEXT = (
    "최종 선 IoU(채택 시 after, 미채택 시 before) ≥ 0.80 → Successful / "
    "0.30 ≤ IoU < 0.80 또는 페이지 크기(pt) 다름 또는 정렬 미수행·오류 → Review Required / "
    "IoU < 0.30 → Failed. 엔진 결과는 바꾸지 않는 표시용 라벨."
)
PAGE_SIZE_TOL_PT = 0.5
DETECTION_METHOD = ("legacy_v10: render(zoom=dpi/72, PDF 주석 포함) → line_mask(gray<210) → "
                    "apply_tolerance → find_change_regions(1mm grid, 2mm merge)")


def engine_info() -> dict[str, Any]:
    return {
        **_VERSION,
        "extracted_sha256": _EXTRACT_SHA,
        "opencv_available": bool(E.HAS_CV2),
        "env": {
            "python": sys.version.split()[0],
            "pymupdf": getattr(E.fitz, "VersionBind", "unknown"),
            "opencv": E.cv2.__version__ if E.HAS_CV2 else None,
            "numpy": np.__version__,
        },
    }


def thresholds_snapshot(dpi: int, tol_mm: float) -> dict[str, Any]:
    """비교에 실제로 사용된 엔진 상수(코드에서 읽음). 값을 새로 정하지 않는다."""
    return {
        "LINE_THRESHOLD_gray_lt": E.LINE_THRESHOLD,
        "tol_mm": tol_mm,
        "tol_px": E.tolerance_px(tol_mm, dpi),
        "CHANGE_MERGE_GAP_MM": E.CHANGE_MERGE_GAP_MM,
        "CHANGE_MIN_PIXELS": E.CHANGE_MIN_PIXELS,
        "CHANGE_REGION_MAX_FRAC": E.CHANGE_REGION_MAX_FRAC,
        "SLIVER_MAX_THICK_PX": E.SLIVER_MAX_THICK_PX,
        "SLIVER_MAX_LEN_MM": E.SLIVER_MAX_LEN_MM,
        "grid_cell_px": max(2, int(round(E._mm_to_px(1.0, dpi)))),
        "orb_nfeatures": 5000,
        "match_keep_ratio": 0.2,
        "ransac_reproj_threshold_px": 5.0,
        "align_adopt_rule": "IoU(after) > IoU(before)",
        "note": "orb/match/ransac 값은 align_old_to_new 함수 내부 상수(코드 확인값)",
    }


def page_sizes_pt(data: bytes) -> list[tuple[float, float]]:
    doc = E.fitz.open(stream=data, filetype="pdf")
    try:
        return [(round(doc[i].rect.width, 3), round(doc[i].rect.height, 3)) for i in range(doc.page_count)]
    finally:
        doc.close()


def alignment_status(info: Any, old_exists: bool, new_exists: bool,
                     old_size_pt: tuple[float, float] | None,
                     new_size_pt: tuple[float, float] | None) -> dict[str, Any]:
    notes: list[str] = []
    reason = info.reason or ""
    iou_known = ("선 IoU" in reason) and (reason.startswith("정렬 채택") or reason.startswith("정렬 미채택"))
    final_iou: float | None = float(info.iou_after if info.adopted else info.iou_before) if iou_known else None
    size_diff = bool(old_size_pt and new_size_pt and (abs(old_size_pt[0] - new_size_pt[0]) > PAGE_SIZE_TOL_PT
                                                      or abs(old_size_pt[1] - new_size_pt[1]) > PAGE_SIZE_TOL_PT))
    if not (old_exists and new_exists):
        status = "Alignment Review Required"
        notes.append("한쪽 문서에 없는 페이지")
    elif final_iou is None:
        status = "Alignment Review Required"
        notes.append(f"정렬 IoU 없음 ({reason})")
    elif final_iou < ALIGN_FAIL_MAX_IOU:
        status = "Alignment Failed"
        notes.append(f"최종 IoU {final_iou:.3f} < {ALIGN_FAIL_MAX_IOU}")
    elif final_iou < ALIGN_OK_MIN_IOU:
        status = "Alignment Review Required"
        notes.append(f"최종 IoU {final_iou:.3f} < {ALIGN_OK_MIN_IOU}")
    else:
        status = "Alignment Review Required" if size_diff else "Alignment Successful"
    if size_diff:
        notes.append(f"페이지 크기 다름 (Old {old_size_pt[0]:.1f}×{old_size_pt[1]:.1f}pt, "  # type: ignore[index]
                     f"New {new_size_pt[0]:.1f}×{new_size_pt[1]:.1f}pt)")  # type: ignore[index]
    return {
        "status": status, "engine_adopted": bool(info.adopted), "engine_reason": reason,
        "iou_before": float(info.iou_before), "iou_after": float(info.iou_after), "final_iou": final_iou,
        "matrix": None if info.matrix is None else np.asarray(info.matrix).tolist(),
        "inverse": None if info.inverse is None else np.asarray(info.inverse).tolist(),
        "notes": notes, "rule": ALIGNMENT_RULE_TEXT,
    }


def worst_status(statuses: list[str]) -> str:
    order = ["Alignment Successful", "Alignment Review Required", "Alignment Failed"]
    return max(statuses, key=order.index) if statuses else "Alignment Review Required"


def mask_sha(mask: np.ndarray) -> str:
    return hashlib.sha256(np.ascontiguousarray(mask).tobytes()).hexdigest()


# ------------------------------------------------------------------ 마크업 (엔진 Markup 모델 그대로 사용)
def markup_geometry_error(kind: str, pts: list[list[float]]) -> str | None:
    """엔진 add_markup_annot / callout_leader 가 요구하는 점 개수 (코드 확인값)."""
    need = {"textbox": 2, "rect": 2, "ellipse": 2, "cloud": 2, "line": 2, "arrow": 2, "callout": 3}
    if kind == "polygon":
        return None if len(pts) >= 3 else "polygon 은 점이 3개 이상이어야 합니다"
    if kind not in need:
        return f"알 수 없는 마크업 종류: {kind}"
    if len(pts) != need[kind]:
        return f"{kind} 는 점이 {need[kind]}개여야 합니다 (입력 {len(pts)})"
    if kind in E.RECT_KINDS:
        x0, y0, x1, y1 = E.norm_rect(pts[0], pts[1])
        if x1 - x0 <= 0 or y1 - y0 <= 0:
            return "영역의 폭과 높이가 0보다 커야 합니다"
    return None


def to_engine_markups(rows: dict[int, list[dict[str, Any]]]) -> dict[int, list[Any]]:
    out: dict[int, list[Any]] = {}
    for page, items in rows.items():
        ms = [E.Markup(i, m["kind"], [list(p) for p in m["pts"]], m.get("text", ""), dict(m["style"]))
              for i, m in enumerate(items, start=1)]
        if ms:
            out[int(page)] = ms
    return out
