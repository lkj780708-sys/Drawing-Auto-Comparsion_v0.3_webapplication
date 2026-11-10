from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

BACKEND = Path(__file__).resolve().parents[1]
ROOT = BACKEND.parent
sys.path.insert(0, str(BACKEND))

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402

SAMPLES = Path(os.environ.get("DAC_SAMPLES_DIR", str(ROOT / "samples")))


def make_client(tmp_path: Path, max_upload_mb: int = 100, static_dir: Path | None = None) -> TestClient:
    cfg = Settings(data_dir=tmp_path / "data", max_upload_mb=max_upload_mb, max_concurrent_comparisons=1,
                   allowed_origins=("http://localhost:3000",),
                   settings_json_path=tmp_path / "compare_drawings_overlay_settings.json", static_dir=static_dir)
    return TestClient(create_app(cfg))


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    with make_client(tmp_path) as c:
        yield c


def new_project(c: TestClient, name: str = "test") -> str:
    r = c.post("/api/projects", json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def upload(c: TestClient, pid: str, path: Path, name: str | None = None) -> dict:
    with open(path, "rb") as f:
        r = c.post("/api/documents/upload", data={"project_id": pid},
                   files={"file": (name or path.name, f, "application/pdf")})
    assert r.status_code == 201, r.text
    return r.json()


def run_comparison(c: TestClient, pid: str, old_id: str, new_id: str, dpi: int, tol: float,
                   colors: dict | None = None, auto_align: bool = True) -> dict:
    body = {"project_id": pid, "baseline_document_id": old_id, "comparison_document_id": new_id, "dpi": dpi,
            "auto_align": auto_align, "tol_mm": tol,
            "colors": colors or {"old": "#1F6FEB", "new": "#000000", "changed": "#E0245E"}}
    r = c.post("/api/comparisons", json=body)
    assert r.status_code == 202, r.text
    cid = r.json()["id"]
    st = c.get(f"/api/comparisons/{cid}/status").json()   # TestClient 는 BackgroundTasks 를 응답 전에 실행
    assert st["state"] == "succeeded", st
    return c.get(f"/api/comparisons/{cid}").json()
