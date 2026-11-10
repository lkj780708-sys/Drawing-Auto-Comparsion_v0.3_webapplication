"""신규 시스템(FastAPI 경유) 결과가 Phase 1 Baseline(원본 프로그램 직접 실행)과 완전히 같은지 검증.
Baseline JSON 은 v0.3 의 backend/tests/baseline/ 를, 도면은 samples/ 를 복사해 사용한다 (없으면 skip)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from conftest import SAMPLES, new_project, run_comparison, upload

BASE = Path(__file__).parent / "baseline"
CASES = [
    ("R1_PID_r04_vs_r06__288_0.5", "PID_r04.pdf", "PID_r06.pdf", 288, 0.5, "Alignment Successful"),
    ("R2_BASIN_r2_vs_r3__200_0.25", "BASIN_r2.pdf", "BASIN_r3.pdf", 200, 0.25, "Alignment Successful"),
    ("A1_PID_r06_same__200_0.25", "PID_r06.pdf", "PID_r06.pdf", 200, 0.25, "Alignment Successful"),
    ("D_PID_vector_vs_raster150__200_0.25", "PID_r06.pdf", "D_PID_r06_raster150.pdf", 200, 0.25,
     "Alignment Review Required"),
    ("E3_PID_pagerot90__200_0.25", "PID_r06.pdf", "E3_PID_r06_pagerot90.pdf", 200, 0.25,
     "Alignment Review Required"),
    ("F_PID_vs_BASIN__200_0.25", "PID_r06.pdf", "BASIN_r3.pdf", 200, 0.25, "Alignment Failed"),
]


@pytest.mark.parametrize("case,old,new,dpi,tol,expect_align", CASES, ids=[c[0] for c in CASES])
def test_same_as_legacy(client, case, old, new, dpi, tol, expect_align):
    bf = BASE / f"{case}.json"
    if not bf.exists() or not (SAMPLES / old).exists() or not (SAMPLES / new).exists():
        pytest.skip("Baseline JSON 또는 Sample 없음 (v0.3 에서 복사 필요)")
    base = json.loads(bf.read_text(encoding="utf-8"))
    pid = new_project(client)
    o = upload(client, pid, SAMPLES / old)
    n = upload(client, pid, SAMPLES / new)
    assert o["sha256"] == base["old_sha256"] and n["sha256"] == base["new_sha256"]
    cmp_ = run_comparison(client, pid, o["id"], n["id"], dpi, tol)
    assert len(cmp_["pages"]) == len(base["pages"])
    changes = client.get(f"/api/comparisons/{cmp_['id']}/changes").json()
    for bp, np_ in zip(base["pages"], cmp_["pages"]):
        assert np_["size_px"] == bp["size_px"]
        assert np_["stats"] == bp["stats"]
        assert np_["alignment"]["engine_adopted"] == bp["align"]["adopted"]
        assert np_["alignment"]["engine_reason"] == bp["align"]["reason"]
        assert np_["mask_sha256"]["old"] == bp["sha_old_mask"]
        assert np_["mask_sha256"]["new"] == bp["sha_new_mask"]
        got = [[c["detection"]["region_no"], *(int(c["detection"]["bounding_box_px"][k]) for k in
                                                ("x0", "y0", "x1", "y1")),
                c["detection"]["removed_px"], c["detection"]["added_px"]]
               for c in changes if c["baseline_page"] == bp["page"]]
        assert got == bp["regions"]
        assert np_["alignment"]["status"] == expect_align
