"""v0.4.1 오른쪽 클릭 삭제(변경 없음)·복원 API 테스트.
DB 에 비교 결과를 직접 넣어 검토 로직만 검증 (도면 불필요). 실행: python -m pytest tests/test_dismiss.py -v"""
import json, sqlite3, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from app.main import create_app


def Settings(data_dir):  # v0.4 의 Settings 는 인자가 더 많음
    from app.config import Settings as S
    return S(data_dir=data_dir, max_upload_mb=100, max_concurrent_comparisons=1, allowed_origins=('http://localhost:3000',),
             settings_json_path=data_dir / 'settings.json', static_dir=None)

P, D, C = "1" * 32, "2" * 32, "3" * 32
CH = ["a" * 32, "b" * 32]


def seed(app):
    db = app.state.db
    page = {"page_index": 0, "size_px": [100, 100], "old_exists": True, "new_exists": True, "old_page_size_pt": [1, 1],
            "new_page_size_pt": [1, 1], "stats": {"unchanged": 1, "removed": 1, "added": 1}, "change_count": 2,
            "alignment": {"status": "Alignment Successful", "engine_adopted": False, "engine_reason": "x", "iou_before": 1.0,
                          "iou_after": 1.0, "final_iou": 1.0, "matrix": None, "inverse": None, "notes": [], "rule": "r"},
            "mask_sha256": {"old": "", "new": ""}, "old_aligned": {}}
    result = {"pages": [page], "detection_method": "stub",
              "thresholds": {}, "engine": {}, "overall_alignment_status": "Alignment Successful"}
    with db.tx() as c:
        c.execute("INSERT INTO projects VALUES (?,?,?,?)", (P, "p", None, "2026-01-01T00:00:00+00:00"))
        c.execute("INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?)", (D, P, "a.pdf", "x", "s" * 64, 1, 1, "[[1,1]]", "", "2026-01-01T00:00:00+00:00"))
        c.execute("INSERT INTO comparisons(id,project_id,baseline_doc_id,comparison_doc_id,settings_json,state,stage,result_json,created_at) "
                  "VALUES (?,?,?,?,?,?,?,?,?)", (C, P, D, D, json.dumps({"dpi": 200}), "succeeded", "done", json.dumps(result), "2026-01-01T00:00:00+00:00"))
        for i, cid in enumerate(CH, 1):
            c.execute("INSERT INTO changes VALUES (?,?,?,?,?,?,?,?,?,?,?)", (cid, C, 0, i, 10, 10, 20, 20, 5, 6, "2026-01-01T00:00:00+00:00"))
            c.execute("INSERT INTO reviews(change_id,status) VALUES (?,'Unreviewed')", (cid,))


def client(tmp_path):
    app = create_app(Settings(data_dir=tmp_path / "data"))
    seed(app)
    return TestClient(app)


def test_dismiss_restore_history(tmp_path):
    with client(tmp_path) as c:
        before = c.get(f"/api/comparisons/{C}/changes").json()[0]
        c.patch(f"/api/changes/{CH[0]}", json={"status": "Needs Review", "comment": "확인 필요", "reviewer": "KJ"})
        r = c.post(f"/api/changes/{CH[0]}/dismiss", json={"reviewer": "KJ"})
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["review"]["status"] == "No Change" and j["review"]["dismissed"] is True and j["review"]["dismissed_by"] == "KJ"
        assert j["detection"] == before["detection"]                       # 자동 탐지 결과 보존
        assert j["review"]["comment"] == "확인 필요"
        assert c.post(f"/api/changes/{CH[0]}/dismiss", json={}).status_code == 409
        h = c.get(f"/api/changes/{CH[0]}/history").json()
        assert [x["label"] for x in h] == ["판정 변경", "사용자 삭제 (변경 없음)"] and h[1]["status"] == "No Change"
        r = c.post(f"/api/changes/{CH[0]}/restore", json={"reviewer": "KJ"}).json()
        assert r["review"]["status"] == "Needs Review" and r["review"]["dismissed"] is False   # 삭제 직전 판정으로 복원
        assert c.get(f"/api/changes/{CH[0]}/history").json()[-1]["label"] == "삭제 복원"
        assert c.post(f"/api/changes/{CH[0]}/restore", json={}).status_code == 409
        s = c.get(f"/api/comparisons/{C}").json()["review_summary"]
        assert s["Needs Review"] == 1 and s["Unreviewed"] == 1


def test_review_change_clears_dismiss(tmp_path):
    with client(tmp_path) as c:
        c.post(f"/api/changes/{CH[1]}/dismiss", json={})
        assert c.get(f"/api/changes/{CH[1]}/history").json()[-1]["status"] == "No Change"
        r = c.patch(f"/api/changes/{CH[1]}", json={"status": "Confirmed Change"}).json()
        assert r["review"]["dismissed"] is False
        assert c.get(f"/api/changes/{CH[1]}/history").json()[-1]["label"] == "판정 변경 (삭제 해제)"
        # 'No Change' 로 다시 판정하면 삭제 표시는 생기지 않음 (삭제는 오른쪽 클릭으로만)
        r = c.patch(f"/api/changes/{CH[1]}", json={"status": "No Change"}).json()
        assert r["review"]["dismissed"] is False


def test_locked_and_bad_ids(tmp_path):
    with client(tmp_path) as c:
        c.patch(f"/api/comparisons/{C}", json={"review_completed": True, "reviewer": "KJ"})
        assert c.post(f"/api/changes/{CH[0]}/dismiss", json={}).status_code == 409
        assert c.post("/api/changes/zz/dismiss", json={}).status_code == 404
        assert c.post(f"/api/changes/{CH[0]}/dismiss", json={"x": 1}).status_code == 422


def test_migration_on_v04_db(tmp_path):
    """v0.4 형식 DB(새 컬럼 없음)를 열면 컬럼만 추가되고 기존 이력은 그대로."""
    from app import db as dbm
    d = tmp_path / "data"; d.mkdir()
    con = sqlite3.connect(d / "dac.sqlite3")
    old = dbm.SCHEMA
    con.executescript(old)
    for t, col, _ in dbm.MIGRATIONS:
        pass
    con.execute("CREATE TABLE IF NOT EXISTS x(a)")
    con.commit(); con.close()
    # 새 컬럼이 없는 v0.4 스키마를 흉내: reviews 를 옛 형태로 다시 만든다
    con = sqlite3.connect(d / "dac.sqlite3")
    con.executescript("DROP TABLE reviews; CREATE TABLE reviews(change_id TEXT PRIMARY KEY, status TEXT NOT NULL, comment TEXT, reviewer TEXT, reviewed_at TEXT);"
                      "DROP TABLE review_history; CREATE TABLE review_history(id INTEGER PRIMARY KEY AUTOINCREMENT, change_id TEXT NOT NULL, status TEXT NOT NULL, comment TEXT, reviewer TEXT, changed_at TEXT NOT NULL);"
                      "INSERT INTO review_history(change_id,status,changed_at) VALUES ('q','No Change','2026-01-01T00:00:00+00:00');")
    con.commit(); con.close()
    dbm.Database(d / "dac.sqlite3")
    con = sqlite3.connect(d / "dac.sqlite3")
    cols = {r[1] for r in con.execute("PRAGMA table_info(reviews)")}
    assert {"dismissed_at", "dismissed_by", "dismissed_prev_status"} <= cols
    assert con.execute("SELECT action FROM review_history").fetchone()[0] == "review"
