"""API 동작 테스트 (작은 합성 PDF 사용). AI 테스트는 외부 호출 없이 엔진 함수를 대체(mock)해서 흐름만 검증."""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path

import numpy as np
import pymupdf as fitz
import pytest
from PIL import Image

from conftest import make_client, new_project, run_comparison, upload
from engine import legacy_v10 as E


def _pdf(path: Path, extra: bool = False, encrypt: bool = False) -> Path:
    d = fitz.open()
    p = d.new_page(width=420, height=297)
    p.draw_rect(fitz.Rect(10, 10, 410, 287), width=1)
    p.draw_circle((120, 150), 40, width=0.8)
    p.insert_text((250, 260), "PUMP P-101", fontsize=10)
    if extra:
        p.draw_line((250, 80), (380, 80), width=0.8)
        p.draw_circle((300, 200), 12, width=0.8)
    kw = dict(encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="u", owner_pw="o") if encrypt else {}
    d.save(path, **kw)
    return path


@pytest.fixture
def pair(client, tmp_path):
    pid = new_project(client)
    o = upload(client, pid, _pdf(tmp_path / "old.pdf"))
    n = upload(client, pid, _pdf(tmp_path / "new.pdf", extra=True))
    return client, pid, run_comparison(client, pid, o["id"], n["id"], 150, 0.25)


# ------------------------------------------------------------------ 업로드 보안
def test_reject_non_pdf_and_fake(client):
    pid = new_project(client)
    r = client.post("/api/documents/upload", data={"project_id": pid}, files={"file": ("a.png", b"%PDF-1.7", "image/png")})
    assert r.status_code == 415
    r = client.post("/api/documents/upload", data={"project_id": pid}, files={"file": ("a.pdf", b"PK\x03\x04", "x")})
    assert r.status_code == 422 and r.json()["detail"] == "PDF 파일이 아닙니다."


def test_reject_encrypted_pdf(client, tmp_path):
    pid = new_project(client)
    r = client.post("/api/documents/upload", data={"project_id": pid},
                    files={"file": ("e.pdf", _pdf(tmp_path / "e.pdf", encrypt=True).read_bytes(), "application/pdf")})
    assert r.status_code == 422 and "암호" in r.json()["detail"]


def test_upload_size_limit(tmp_path):
    with make_client(tmp_path, max_upload_mb=1) as c:
        pid = new_project(c)
        r = c.post("/api/documents/upload", data={"project_id": pid},
                   files={"file": ("big.pdf", b"%PDF" + b"0" * (2 * 1024 * 1024), "application/pdf")})
        assert r.status_code == 413
        assert list((tmp_path / "data" / "tmp").iterdir()) == []


def test_filename_not_used_as_path(client, tmp_path):
    from app.storage import sanitize_display_name
    pid = new_project(client)
    d = upload(client, pid, _pdf(tmp_path / "x.pdf"), name="../../etc/..\\evil name.pdf")
    assert d["original_name"] == "evil name.pdf"
    assert [p.name for p in (client.app.state.storage.root / "uploads").iterdir()] == [f"{d['id']}.pdf"]
    assert sanitize_display_name("a/b\\c\x00d\te.pdf") == "cde.pdf"
    assert client.get("/api/comparisons/abc").status_code == 404


# ------------------------------------------------------------------ 설정 (기존 설정 파일 형식)
def test_settings_roundtrip_legacy_format(client, tmp_path):
    s = client.get("/api/settings").json()
    assert s["dpi"] == E.DEFAULT_DPI and s["settings_file_exists"] is False
    r = client.patch("/api/settings", json={"dpi": 288, "tol_mm": 0.5, "colors": {"old": "#1f6feb", "new": "#000000",
                                                                                 "changed": "#E0245E"},
                                            "menu_pinned": True, "menu_width": 420})
    assert r.status_code == 200, r.text
    f = tmp_path / "compare_drawings_overlay_settings.json"
    loaded, warns = E.load_settings(str(f))          # 기존 프로그램의 로더로 다시 읽어도 같은 값
    assert warns == [] and loaded["dpi"] == 288 and loaded["change_tol_mm"] == 0.5
    assert loaded["compare_colors"]["old"] == "#1F6FEB" and loaded["menu_pinned"] is True and loaded["menu_width"] == 420
    assert client.patch("/api/settings", json={"dpi": 300}).status_code == 422
    assert client.patch("/api/settings", json={"menu_width": 9999}).status_code == 422
    bad = client.patch("/api/settings", json={"tool_defaults": {"rect": {**E.BASE_STYLE, "width": 99}}})
    assert bad.status_code == 422
    ok = client.patch("/api/settings", json={"tool_defaults": {"rect": {**E.BASE_STYLE, "stroke": "#FF0000"}}})
    assert ok.json()["tool_defaults"]["rect"]["stroke"] == "#FF0000"


# ------------------------------------------------------------------ 결과·추적성·검토
def test_traceability_and_review(pair):
    c, pid, cmp_ = pair
    assert cmp_["engine"]["source_sha256"].startswith("ab805e1d")
    assert cmp_["thresholds"]["LINE_THRESHOLD_gray_lt"] == 210
    assert cmp_["stage"].startswith("비교 완료:")
    ch = c.get(f"/api/comparisons/{cmp_['id']}/changes").json()
    assert ch and ch[0]["ai"] is None
    before = ch[0]["detection"]
    r = c.patch(f"/api/changes/{ch[0]['change_id']}", json={"status": "Confirmed Change", "comment": "확인", "reviewer": "KJ"})
    assert r.status_code == 200 and r.json()["detection"] == before
    assert c.patch(f"/api/changes/{ch[0]['change_id']}", json={"removed_px": 0}).status_code == 422
    c.patch(f"/api/comparisons/{cmp_['id']}", json={"review_completed": True, "reviewer": "KJ"})
    assert c.patch(f"/api/changes/{ch[0]['change_id']}", json={"status": "No Change"}).status_code == 409


# ------------------------------------------------------------------ 표시 (재비교 없음, 엔진 함수 그대로)
def test_overlay_color_change_uses_engine(pair):
    from app.storage import load_mask_png
    c, pid, cmp_ = pair
    r = c.get(f"/api/comparisons/{cmp_['id']}/pages/0/image", params={"layer": "overlay", "old": "#A0A0A0", "changed": "#17BF63"})
    arr = np.array(Image.open(io.BytesIO(r.content)).convert("RGB"))
    pd = c.app.state.storage.page_dir(cmp_["id"], 0)
    expect = E.make_overlay(load_mask_png(pd / "old_mask.png"), load_mask_png(pd / "new_mask.png"),
                            {"old": "#A0A0A0", "new": "#000000", "changed": "#17BF63"})
    assert np.array_equal(arr, expect)


def test_bubbles_and_card_regions_match_engine(pair, tmp_path):
    c, pid, cmp_ = pair
    res = E.compare_pdfs((tmp_path / "old.pdf").read_bytes(), (tmp_path / "new.pdf").read_bytes(), 150, True, tol_mm=0.25)
    p = res.pages[0]
    zoom = 0.37
    want = E.place_bubbles(p.changes, p.integral(), p.ink_block, E.BUBBLE_RADIUS_PX / zoom, *p.size_px)
    got = c.get(f"/api/comparisons/{cmp_['id']}/pages/0/bubbles", params={"zoom": zoom}).json()
    assert [(b["region_no"], round(b["cx"], 6), round(b["cy"], 6), b["clear"]) for b in got] == \
           [(b.region_id, round(b.cx, 6), round(b.cy, 6), b.clear) for b in want]
    ox, oy, w, h, mag = 900, 100, 640, 300, 4.0
    k = 150 / 72
    H, W = p.old_mask.shape
    rx0, ry0 = max(0, int(np.floor(ox / mag * k))), max(0, int(np.floor(oy / mag * k)))
    rx1, ry1 = min(W, int(np.ceil((ox + w) / mag * k))), min(H, int(np.ceil((oy + h) / mag * k)))
    regs = E.find_change_regions(p.old_mask[ry0:ry1, rx0:rx1], p.new_mask[ry0:ry1, rx0:rx1], 150, gap_mm=0.8,
                                 min_pixels=1, offset=(rx0, ry0))
    got = c.get(f"/api/comparisons/{cmp_['id']}/pages/0/card_regions",
                params={"ox": ox, "oy": oy, "w_px": w, "h_px": h, "mag": mag}).json()
    assert got["total"] == len(regs) and [[b["x0"], b["y0"], b["x1"], b["y1"]] for b in got["regions"]] == \
           [[r.x0, r.y0, r.x1, r.y1] for r in regs]
    img = c.get(f"/api/comparisons/{cmp_['id']}/pages/0/region", params={"which": "old", "ox": ox, "oy": oy, "w_px": w,
                                                                        "h_px": h, "mag": mag})
    assert np.array_equal(np.array(Image.open(io.BytesIO(img.content)).convert("RGB")),
                          E.render_old_aligned_region(res.doc("old"), 0, ox, oy, mag, w, h, 150, None))
    res.close()


# ------------------------------------------------------------------ 마크업 + 내보내기
STYLE = {"fill": None, "stroke": "#0000FF", "width": 1.0, "text_color": "#000000", "font": "Arial", "font_size": 12.0}


def test_markups_and_exports(pair, tmp_path):
    c, pid, cmp_ = pair
    url = f"/api/comparisons/{cmp_['id']}/pages/0/markups"
    assert c.put(url, json={"markups": [{"kind": "rect", "pts": [[10, 10]], "style": STYLE}]}).status_code == 422
    ms = [{"kind": "cloud", "pts": [[240, 60], [390, 100]], "style": STYLE},
          {"kind": "callout", "pts": [[260, 120], [380, 150], [300, 80]], "text": "추가 라인", "style": STYLE},
          {"kind": "polygon", "pts": [[20, 20], [60, 20], [40, 50]], "style": {**STYLE, "fill": "#98FB98"}},
          {"kind": "arrow", "pts": [[100, 250], [200, 200]], "style": STYLE}]
    assert len(c.put(url, json={"markups": ms}).json()["markups"]) == 4
    ov = c.post(f"/api/comparisons/{cmp_['id']}/export", json={"kind": "overlay_pdf"})
    assert ov.status_code == 201, ov.text
    assert ov.json()["verification"] == {"pages": 1, "annots": 4} and ov.json()["file_name"] == "old_compare_result.pdf"
    d = fitz.open(stream=c.get(ov.json()["download_url"]).content, filetype="pdf")
    assert d.metadata["subject"] == E.RESULT_MARK and len(list(d[0].annots())) == 4
    nw = c.post(f"/api/comparisons/{cmp_['id']}/export", json={"kind": "new_pdf"}).json()
    assert nw["verification"]["annots"] == 4 and nw["file_name"] == "new_markup.pdf"
    js = c.post(f"/api/comparisons/{cmp_['id']}/export", json={"kind": "result_json"}).json()
    body = c.get(js["download_url"]).content
    assert hashlib.sha256(body).hexdigest() == js["sha256"] and json.loads(body)["format_version"] == 2
    # Overlay PDF 이미지 = 엔진 직접 실행 Overlay
    ex = c.post(f"/api/comparisons/{cmp_['id']}/export", json={"kind": "overlay_pdf", "include_markups": False}).json()
    d = fitz.open(stream=c.get(ex["download_url"]).content, filetype="pdf")
    api_arr = np.array(Image.open(io.BytesIO(d.extract_image(d[0].get_images()[0][0])["image"])).convert("RGB"))
    res = E.compare_pdfs((tmp_path / "old.pdf").read_bytes(), (tmp_path / "new.pdf").read_bytes(), 150, True, tol_mm=0.25)
    assert np.array_equal(api_arr, res.overlay(0, cmp_["settings"]["colors"]))


# ------------------------------------------------------------------ AI (mock: 외부 전송 없음)
def test_ai_flow_mocked(pair, monkeypatch):
    c, pid, cmp_ = pair
    calls = {"estimate": 0, "call": 0}
    monkeypatch.setattr(E, "ai_available", lambda: True)
    monkeypatch.setattr(E, "ai_get_key", lambda: None)
    assert c.post(f"/api/comparisons/{cmp_['id']}/ai/estimate").status_code == 409     # AI 사용 미체크
    assert c.patch("/api/settings", json={"ai_enabled": True}).status_code == 200
    monkeypatch.setattr(E, "ai_make_client", lambda: object())

    def fake_estimate(client, jobs):
        calls["estimate"] += 1
        assert all(j["content"][1]["type"] == "image" for j in jobs)   # 엔진 ai_build_jobs 가 만든 실제 작업
        return 1234, 0.05
    monkeypatch.setattr(E, "ai_estimate", fake_estimate)

    def fake_call(client, job):
        calls["call"] += 1
        return {key: {"result": "real", "summary": "선 추가"} for key in job["items"].values()}
    monkeypatch.setattr(E, "ai_call", fake_call)
    est = c.post(f"/api/comparisons/{cmp_['id']}/ai/estimate")
    assert est.status_code == 201, est.text
    run = est.json()
    assert run["state"] == "estimated" and "Anthropic으로 전송" in run["confirm_text"] and calls["call"] == 0
    assert c.post(f"/api/ai/runs/{run['id']}/start").status_code == 200
    import time
    for _ in range(50):
        if c.get(f"/api/ai/runs/{run['id']}").json()["state"] == "succeeded":
            break
        time.sleep(0.05)
    ch = c.get(f"/api/comparisons/{cmp_['id']}/changes").json()
    assert all(x["ai"]["result"] == "real" and x["ai"]["label"] == "실제 변경" for x in ch)
    assert all(x["review"]["status"] == "Unreviewed" for x in ch)      # 사용자 판정은 그대로
    again = c.post(f"/api/comparisons/{cmp_['id']}/ai/estimate")
    assert again.status_code == 409 and "추가 비용 없음" in again.json()["detail"]


def test_ai_key_requires_library(client, monkeypatch):
    monkeypatch.setattr(E, "ai_available", lambda: False)
    assert client.post("/api/ai/key", json={"key": "sk-ant-x"}).status_code == 409
    assert client.get("/api/ai/status").json()["available"] is False


# ------------------------------------------------------------------ 창 1개 실행 (빌드 화면 제공)
def test_static_ui_served(tmp_path):
    st = tmp_path / "out"
    st.mkdir()
    (st / "index.html").write_text("<html>DAC</html>", encoding="utf-8")
    with make_client(tmp_path, static_dir=st) as c:
        assert "DAC" in c.get("/").text
        assert c.get("/api/health").json()["static_ui"] is True


def test_restart_marks_running_failed(tmp_path):
    with make_client(tmp_path) as c:
        pid = new_project(c)
        o = upload(c, pid, _pdf(tmp_path / "o.pdf"))
        c.app.state.db.run("INSERT INTO comparisons(id, project_id, baseline_doc_id, comparison_doc_id, settings_json, "
                           "state, stage, created_at) VALUES (?,?,?,?,?,?,?,?)",
                           ("a" * 32, pid, o["id"], o["id"], "{}", "running", "x", "2026-01-01T00:00:00+00:00"))
    with make_client(tmp_path) as c2:
        st = c2.get(f"/api/comparisons/{'a' * 32}/status").json()
        assert st["state"] == "failed" and "재시작" in st["error"]
