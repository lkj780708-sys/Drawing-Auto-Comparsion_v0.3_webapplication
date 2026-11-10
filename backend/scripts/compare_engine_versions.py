"""이전 엔진(v0.3 의 backend/engine/legacy_v10.py)과 새 엔진의 함수·클래스·상수를 AST 로 비교한다.
사용: python scripts/compare_engine_versions.py <이전 legacy_v10.py 경로>
비교 결과에 영향을 주는 정의(2부 비교 엔진, 4부 저장)가 모두 같으면 '엔진 동일'로 판정한다."""
from __future__ import annotations

import ast
import sys
from pathlib import Path

NEW = Path(__file__).resolve().parents[1] / "engine" / "legacy_v10.py"
ENGINE_CORE = {
    "read_pdf_checked", "_pix_to_array", "render_page_array", "render_page_transformed", "render_pdf",
    "pad_to_same_size", "line_mask", "AlignInfo", "_iou", "align_old_to_new", "_rgb", "make_overlay",
    "_dilate_fast", "tolerance_px", "apply_tolerance", "overlay_stats", "ChangeRegion", "_dilate_bool",
    "_cell_counts", "_components", "find_change_regions", "PageResult", "compare_pdfs", "render_pt_region",
    "render_old_aligned_region", "add_markup_annot", "verify_saved_pdf", "save_new_pdf", "save_overlay_pdf",
    "=LINE_THRESHOLD", "=CHANGE_MERGE_GAP_MM", "=CHANGE_MIN_PIXELS", "=CHANGE_TOL_CHOICES", "=CHANGE_TOL_DEFAULT",
    "=CHANGE_REGION_MAX_FRAC", "=SLIVER_MAX_THICK_PX", "=SLIVER_MAX_LEN_MM", "=DPI_CHOICES", "=DEFAULT_DPI",
}


def defs(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for n in ast.parse(path.read_text(encoding="utf-8")).body:
        if isinstance(n, (ast.FunctionDef, ast.ClassDef)):
            out[n.name] = ast.dump(n)
        elif isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name):
            out["=" + n.targets[0].id] = ast.dump(n.value)
    return out


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    old, new = defs(Path(sys.argv[1])), defs(NEW)
    changed = sorted(k for k in old.keys() & new.keys() if old[k] != new[k])
    added = sorted(new.keys() - old.keys())
    removed = sorted(old.keys() - new.keys())
    core_changed = [k for k in changed + removed if k in ENGINE_CORE]
    print(f"공통 정의 {len(old.keys() & new.keys())}개 / 변경 {len(changed)} / 추가 {len(added)} / 삭제 {len(removed)}")
    for title, items in (("변경", changed), ("추가", added), ("삭제", removed)):
        if items:
            print(f"[{title}] " + ", ".join(items))
    if core_changed:
        print("결과: 비교 엔진 핵심 정의가 다릅니다 → Baseline 재측정 필요: " + ", ".join(core_changed))
        return 1
    print("결과: 비교 엔진 핵심 정의 동일 (비교 결과에 영향 없음)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
