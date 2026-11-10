"""Drawing Auto Comparison – FastAPI Adapter.

비교·정렬·검출·AI 검증은 engine/legacy_v10.py 를 그대로 호출한다. 이 파일은 입출력·저장·검토 상태만 다룬다.
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import threading
import uuid
from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncIterator, Literal, Optional
from urllib.parse import quote

import numpy as np
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image

from engine import legacy_v10 as E

from . import engine_adapter as A
from . import schemas as S
from .config import Settings, load_settings
from .db import Database, dumps, now_iso
from .runner import Runner
from .storage import Storage, load_mask_png, load_rgb_png, sanitize_display_name

log = logging.getLogger("dac.api")

REVIEW_STATES = ("Unreviewed", "Confirmed Change", "No Change", "False Positive", "Needs Review")


def _dt(v: Optional[str]) -> Optional[datetime]:
    return datetime.fromisoformat(v) if v else None


def create_app(settings: Settings | None = None) -> FastAPI:
    cfg = settings or load_settings()
    storage = Storage(cfg.data_dir)
    db = Database(cfg.data_dir / "dac.sqlite3")
    runner = Runner(db, storage, cfg.max_concurrent_comparisons)
    settings_lock = threading.Lock()
    mask_cache: "OrderedDict[tuple[str, int], dict[str, Any]]" = OrderedDict()
    cache_lock = threading.Lock()
    ai_pending: dict[str, tuple[Any, list[dict[str, Any]]]] = {}     # run_id → (client, jobs)  (메모리에만)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        # 서버가 재시작되면 진행 중이던 작업은 이어서 할 수 없으므로 실패로 기록 (결과를 정상처럼 남기지 않음)
        db.run("UPDATE comparisons SET state='failed', stage='실패: 서버 재시작', "
               "error='서버 재시작으로 작업이 중단되었습니다. 다시 실행해 주세요.', finished_at=? "
               "WHERE state IN ('queued','running')", (now_iso(),))
        db.run("UPDATE ai_runs SET state='failed', error='서버 재시작으로 중단되었습니다. 받은 결과는 유지됩니다.', "
               "finished_at=? WHERE state IN ('estimated','running')", (now_iso(),))
        for f in storage.tmp_dir().iterdir():
            f.unlink(missing_ok=True)
        yield

    app = FastAPI(title="Drawing Auto Comparison API", version="0.4.1 (engine v10)", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=list(cfg.allowed_origins), allow_methods=["*"],
                       allow_headers=["*"], expose_headers=["Content-Disposition"])
    app.state.cfg, app.state.db, app.state.storage, app.state.runner = cfg, db, storage, runner

    @app.exception_handler(E.PdfOpenError)
    async def _pdf_err(_: Request, exc: E.PdfOpenError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": str(exc)})

    # ------------------------------------------------------------------ helpers
    def _id(v: str, what: str) -> str:
        try:
            return Storage.check_id(v)
        except ValueError:
            raise HTTPException(404, f"{what}을(를) 찾을 수 없습니다")

    def _row(table: str, rid: str, what: str) -> Any:
        row = db.one(f"SELECT * FROM {table} WHERE id=?", (_id(rid, what),))
        if row is None:
            raise HTTPException(404, f"{what}을(를) 찾을 수 없습니다")
        return row

    def _project(pid: str) -> Any:
        return _row("projects", pid, "프로젝트")

    def _doc(did: str) -> Any:
        return _row("documents", did, "문서")

    def _cmp(cid: str) -> Any:
        return _row("comparisons", cid, "비교")

    def _done_cmp(cid: str) -> tuple[Any, dict[str, Any]]:
        row = _cmp(cid)
        if row["state"] != "succeeded":
            raise HTTPException(409, f"비교가 완료되지 않았습니다 (상태: {row['state']})")
        return row, json.loads(row["result_json"])

    def _page(result: dict[str, Any], page: int) -> dict[str, Any]:
        if page < 0 or page >= len(result["pages"]):
            raise HTTPException(404, "페이지가 없습니다")
        return result["pages"][page]

    def _load_settings() -> tuple[dict[str, Any], list[str]]:
        return E.load_settings(str(cfg.settings_json_path))

    def _ai_enabled() -> bool:
        return bool(_load_settings()[0].get("ai_enabled")) and E.ai_available()

    def _masks(cid: str, pg: dict[str, Any]) -> dict[str, Any]:
        """저장 마스크(무손실)를 읽고 비교 당시 SHA-256 과 같은지 확인. 최근 2페이지만 메모리에 보관."""
        key = (cid, pg["page_index"])
        with cache_lock:
            if key in mask_cache:
                mask_cache.move_to_end(key)
                return mask_cache[key]
        pd = storage.page_dir(cid, pg["page_index"])
        om, nm = load_mask_png(pd / "old_mask.png"), load_mask_png(pd / "new_mask.png")
        if A.mask_sha(om) != pg["mask_sha256"]["old"] or A.mask_sha(nm) != pg["mask_sha256"]["new"]:
            raise HTTPException(500, f"{pg['page_index'] + 1}페이지 저장 마스크가 비교 당시와 다릅니다")
        entry: dict[str, Any] = {"old": om, "new": nm}
        with cache_lock:
            mask_cache[key] = entry
            while len(mask_cache) > 2:
                mask_cache.popitem(last=False)
        return entry

    def _engine_changes(cid: str, page: int) -> list[Any]:
        rows = db.all("SELECT * FROM changes WHERE comparison_id=? AND page_index=? ORDER BY region_no", (cid, page))
        return [E.ChangeRegion(r["region_no"], r["x0"], r["y0"], r["x1"], r["y1"], r["removed"], r["added"])
                for r in rows]

    def _engine_pages(row: Any, result: dict[str, Any], with_new_img: bool = False) -> list[Any]:
        """저장된 결과로 엔진 PageResult 를 다시 구성 (비교 재실행 없음)."""
        pages = []
        for pgi in result["pages"]:
            m = _masks(row["id"], pgi)
            new_img = load_rgb_png(storage.page_dir(row["id"], pgi["page_index"]) / "new.png") if with_new_img else None
            pages.append(E.PageResult(pgi["page_index"], None, new_img, m["old"], m["new"], pgi["stats"], E.AlignInfo(),
                                      pgi["old_exists"], pgi["new_exists"], _engine_changes(row["id"], pgi["page_index"])))
        return pages

    def _project_out(r: Any) -> S.ProjectOut:
        nd = db.one("SELECT COUNT(*) n FROM documents WHERE project_id=?", (r["id"],))["n"]
        nc = db.one("SELECT COUNT(*) n FROM comparisons WHERE project_id=?", (r["id"],))["n"]
        return S.ProjectOut(id=r["id"], name=r["name"], description=r["description"],
                            created_at=_dt(r["created_at"]), document_count=nd, comparison_count=nc)

    def _doc_out(r: Any) -> S.DocumentOut:
        return S.DocumentOut(id=r["id"], project_id=r["project_id"], original_name=r["original_name"],
                             sha256=r["sha256"], size_bytes=r["size_bytes"], page_count=r["page_count"],
                             page_sizes_pt=[tuple(x) for x in json.loads(r["page_sizes_json"])],
                             origin_hint=r["origin_hint"], uploaded_at=_dt(r["uploaded_at"]))

    def _review_summary(cid: str) -> dict[str, int]:
        out = {k: 0 for k in REVIEW_STATES}
        for r in db.all("SELECT v.status s, COUNT(*) n FROM reviews v JOIN changes c ON c.id=v.change_id "
                        "WHERE c.comparison_id=? GROUP BY v.status", (cid,)):
            out[r["s"]] = r["n"]
        return out

    def _cmp_out(r: Any) -> S.ComparisonOut:
        b, c = _doc(r["baseline_doc_id"]), _doc(r["comparison_doc_id"])
        res = json.loads(r["result_json"]) if r["result_json"] else None
        return S.ComparisonOut(
            id=r["id"], project_id=r["project_id"], state=r["state"], stage=r["stage"],
            baseline_document=S.DocRef(id=b["id"], original_name=b["original_name"], sha256=b["sha256"]),
            comparison_document=S.DocRef(id=c["id"], original_name=c["original_name"], sha256=c["sha256"]),
            settings=json.loads(r["settings_json"]),
            thresholds=res["thresholds"] if res else None, engine=res["engine"] if res else None,
            overall_alignment_status=res["overall_alignment_status"] if res else None,
            pages=[S.PageOut(**p) for p in res["pages"]] if res else [],
            timing_s=res.get("timing_s") if res else None,
            review_summary=_review_summary(r["id"]),
            review_completed_at=_dt(r["review_completed_at"]), review_completed_by=r["review_completed_by"],
            created_at=_dt(r["created_at"]), started_at=_dt(r["started_at"]), finished_at=_dt(r["finished_at"]),
            error=r["error"])

    CHANGE_SQL = ("SELECT c.*, v.status, v.comment, v.reviewer, v.reviewed_at, "
                  "v.dismissed_at, v.dismissed_by, v.dismissed_prev_status, "
                  "a.result ai_result, a.summary ai_summary, a.model ai_model, a.created_at ai_at FROM changes c "
                  "JOIN reviews v ON v.change_id=c.id LEFT JOIN ai_results a ON a.change_id=c.id ")

    def _change_out(r: Any, cmp_row: Any, result: dict[str, Any]) -> S.ChangeOut:
        dpi = json.loads(cmp_row["settings_json"])["dpi"]
        k = 72.0 / dpi
        page = result["pages"][r["page_index"]]
        ai = None
        if r["ai_result"]:
            ai = S.AiOut(result=r["ai_result"], label=E.AI_LABELS.get(r["ai_result"], r["ai_result"]),
                         summary=r["ai_summary"], model=r["ai_model"], created_at=_dt(r["ai_at"]))
        return S.ChangeOut(
            change_id=r["id"], project_id=cmp_row["project_id"], comparison_id=cmp_row["id"],
            baseline_document=cmp_row["baseline_doc_id"], comparison_document=cmp_row["comparison_doc_id"],
            baseline_page=r["page_index"], comparison_page=r["page_index"],
            detection=S.DetectionOut(
                region_no=r["region_no"],
                bounding_box_px=S.BBox(x0=r["x0"], y0=r["y0"], x1=r["x1"], y1=r["y1"]),
                bounding_box_pt=S.BBox(x0=r["x0"] * k, y0=r["y0"] * k, x1=r["x1"] * k, y1=r["y1"] * k),
                dpi=dpi, removed_px=r["removed"], added_px=r["added"],
                detection_method=result["detection_method"], alignment_status=page["alignment"]["status"]),
            review=S.ReviewOut(status=r["status"], comment=r["comment"], reviewer=r["reviewer"],
                               reviewed_at=_dt(r["reviewed_at"]), dismissed=bool(r["dismissed_at"]),
                               dismissed_at=_dt(r["dismissed_at"]), dismissed_by=r["dismissed_by"]),
            ai=ai, created_at=_dt(r["created_at"]))

    # ------------------------------------------------------------------ meta / settings
    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "engine": A.engine_info(), "static_ui": cfg.static_dir is not None}

    def _settings_out() -> S.SettingsOut:
        s, warns = _load_settings()
        return S.SettingsOut(
            dpi_choices=list(E.DPI_CHOICES), tol_mm_choices=list(E.CHANGE_TOL_CHOICES),
            color_choices=dict(E.COLOR_CHOICES), dpi=s["dpi"], auto_align=bool(s["auto_align"] and E.HAS_CV2),
            tol_mm=s["change_tol_mm"], colors=S.Colors(**s["compare_colors"]), tool_defaults=s["tool_defaults"],
            menu_pinned=bool(s["menu_pinned"]), menu_width=int(s["menu_width"]),
            menu_width_range=(E.MENU_WIDTH_MIN, E.MENU_WIDTH_MAX),
            compare_card_size=tuple(s["compare_card_size"]) if s.get("compare_card_size") else None,
            ai_enabled=bool(s.get("ai_enabled")) and E.ai_available(),
            settings_file=cfg.settings_json_path.name, settings_file_exists=cfg.settings_json_path.is_file(),
            settings_warnings=warns, opencv_available=E.HAS_CV2, ai_available=E.ai_available(),
            max_upload_mb=cfg.max_upload_mb, font_note="")

    @app.get("/api/settings", response_model=S.SettingsOut)
    def get_settings() -> S.SettingsOut:
        return _settings_out()

    @app.patch("/api/settings", response_model=S.SettingsOut)
    def patch_settings(body: S.SettingsPatch) -> S.SettingsOut:
        with settings_lock:
            s, _ = _load_settings()
            if body.dpi is not None:
                s["dpi"] = body.dpi
            if body.auto_align is not None:
                s["auto_align"] = body.auto_align
            if body.tol_mm is not None:
                s["change_tol_mm"] = body.tol_mm
            if body.colors is not None:
                s["compare_colors"] = body.colors.model_dump()
            if body.menu_pinned is not None:
                s["menu_pinned"] = body.menu_pinned
            if body.menu_width is not None:
                if not E.MENU_WIDTH_MIN <= body.menu_width <= E.MENU_WIDTH_MAX:
                    raise HTTPException(422, f"menu_width 는 {E.MENU_WIDTH_MIN}~{E.MENU_WIDTH_MAX}")
                s["menu_width"] = body.menu_width
            if body.compare_card_size is not None:
                try:
                    s["compare_card_size"] = E.parse_card_size(list(body.compare_card_size))
                except ValueError as e:
                    raise HTTPException(422, f"compare_card_size: {e}")
            if body.ai_enabled is not None:
                if body.ai_enabled and not E.ai_available():
                    raise HTTPException(409, "anthropic·keyring 미설치 – AI 검증을 사용할 수 없습니다")
                s["ai_enabled"] = body.ai_enabled
            if body.tool_defaults is not None:
                for kind, raw in body.tool_defaults.items():
                    if kind not in E.TOOLS:
                        raise HTTPException(422, f"알 수 없는 도구: {kind}")
                    style, errs = E.validate_style(raw, kind)
                    if errs:
                        raise HTTPException(422, [f"{E.TOOL_LABEL[kind]}: {x}" for x in errs])
                    s["tool_defaults"][kind] = {**E.BASE_STYLE, **style}
            out = dict(s)
            if out.get("compare_card_size"):
                out["compare_card_size"] = list(out["compare_card_size"])
            ok, msg = E.save_settings(str(cfg.settings_json_path), out)
            if not ok:
                raise HTTPException(500, f"설정 저장 실패: {msg}")
        return _settings_out()

    # ------------------------------------------------------------------ projects
    @app.post("/api/projects", response_model=S.ProjectOut, status_code=201)
    def create_project(body: S.ProjectCreate) -> S.ProjectOut:
        pid = uuid.uuid4().hex
        db.run("INSERT INTO projects VALUES (?,?,?,?)", (pid, body.name.strip(), body.description, now_iso()))
        return _project_out(_project(pid))

    @app.get("/api/projects", response_model=list[S.ProjectOut])
    def list_projects() -> list[S.ProjectOut]:
        return [_project_out(r) for r in db.all("SELECT * FROM projects ORDER BY created_at DESC")]

    @app.get("/api/projects/{project_id}", response_model=S.ProjectOut)
    def get_project(project_id: str) -> S.ProjectOut:
        return _project_out(_project(project_id))

    # ------------------------------------------------------------------ documents
    @app.post("/api/documents/upload", response_model=S.DocumentOut, status_code=201)
    async def upload(project_id: str = Form(...), file: UploadFile = File(...)) -> S.DocumentOut:
        _project(project_id)
        display = sanitize_display_name(file.filename)
        if not display.lower().endswith(".pdf"):
            raise HTTPException(415, "PDF 파일(.pdf)만 업로드할 수 있습니다")
        did = uuid.uuid4().hex
        tmp = storage.tmp_dir() / f"{did}.part"
        size = 0
        try:
            with open(tmp, "wb") as f:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > cfg.max_upload_bytes:
                        raise HTTPException(413, f"파일이 너무 큽니다 (최대 {cfg.max_upload_mb}MB)")
                    f.write(chunk)
            # 기존 엔진의 검증 그대로: 매직바이트(%PDF) / 열기 / 암호 / 페이지 수
            data, sha, n = E.read_pdf_checked(str(tmp))
            sizes = A.page_sizes_pt(data)
            hint = E.pdf_origin_hint(data)
            os.replace(tmp, storage.upload_path(did))
        finally:
            tmp.unlink(missing_ok=True)
        db.run("INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?)",
               (did, project_id, display, f"{did}.pdf", sha, size, n, dumps(sizes), hint, now_iso()))
        log.info("document %s uploaded project=%s pages=%d bytes=%d", did, project_id, n, size)
        return _doc_out(_doc(did))

    @app.get("/api/documents", response_model=list[S.DocumentOut])
    def list_documents(project_id: str) -> list[S.DocumentOut]:
        _project(project_id)
        return [_doc_out(r) for r in db.all("SELECT * FROM documents WHERE project_id=? ORDER BY uploaded_at DESC",
                                            (project_id,))]

    @app.get("/api/documents/{document_id}", response_model=S.DocumentOut)
    def get_document(document_id: str) -> S.DocumentOut:
        return _doc_out(_doc(document_id))

    # ------------------------------------------------------------------ comparisons
    def status(comparison_id: str) -> S.JobStatusOut:
        r = _cmp(comparison_id)
        return S.JobStatusOut(id=r["id"], state=r["state"], stage=r["stage"], page_done=r["page_done"],
                              page_total=r["page_total"], error=r["error"])

    @app.post("/api/comparisons", response_model=S.JobStatusOut, status_code=202)
    def create_comparison(body: S.ComparisonCreate, bg: BackgroundTasks) -> S.JobStatusOut:
        _project(body.project_id)
        for did in (body.baseline_document_id, body.comparison_document_id):
            if _doc(did)["project_id"] != body.project_id:
                raise HTTPException(422, "문서가 이 프로젝트에 속하지 않습니다")
        if body.auto_align and not E.HAS_CV2:
            raise HTTPException(422, "opencv-python 미설치로 자동 정렬을 사용할 수 없습니다")
        cid = uuid.uuid4().hex
        st = {"dpi": body.dpi, "auto_align": body.auto_align, "tol_mm": body.tol_mm, "colors": body.colors.model_dump()}
        db.run("INSERT INTO comparisons(id, project_id, baseline_doc_id, comparison_doc_id, settings_json, state, "
               "stage, created_at) VALUES (?,?,?,?,?,?,?,?)",
               (cid, body.project_id, body.baseline_document_id, body.comparison_document_id, dumps(st),
                "queued", "비교 대기…", now_iso()))
        bg.add_task(runner.run, cid)
        return status(cid)

    app.get("/api/comparisons/{comparison_id}/status", response_model=S.JobStatusOut)(status)

    @app.get("/api/comparisons", response_model=list[S.ComparisonOut])
    def list_comparisons(project_id: str) -> list[S.ComparisonOut]:
        _project(project_id)
        return [_cmp_out(r) for r in db.all("SELECT * FROM comparisons WHERE project_id=? ORDER BY created_at DESC",
                                            (project_id,))]

    @app.get("/api/comparisons/{comparison_id}", response_model=S.ComparisonOut)
    def get_comparison(comparison_id: str) -> S.ComparisonOut:
        return _cmp_out(_cmp(comparison_id))

    @app.patch("/api/comparisons/{comparison_id}", response_model=S.ComparisonOut)
    def patch_comparison(comparison_id: str, body: S.ComparisonPatch) -> S.ComparisonOut:
        _done_cmp(comparison_id)
        if body.review_completed:
            db.run("UPDATE comparisons SET review_completed_at=?, review_completed_by=?, review_snapshot_json=? "
                   "WHERE id=?", (now_iso(), body.reviewer, dumps(_review_summary(comparison_id)), comparison_id))
        else:
            db.run("UPDATE comparisons SET review_completed_at=NULL, review_completed_by=NULL, "
                   "review_snapshot_json=NULL WHERE id=?", (comparison_id,))
        return _cmp_out(_cmp(comparison_id))

    @app.get("/api/comparisons/{comparison_id}/changes", response_model=list[S.ChangeOut])
    def list_changes(comparison_id: str, page: Optional[int] = None) -> list[S.ChangeOut]:
        row, result = _done_cmp(comparison_id)
        if page is None:
            rows = db.all(CHANGE_SQL + "WHERE c.comparison_id=? ORDER BY c.page_index, c.region_no", (comparison_id,))
        else:
            _page(result, page)
            rows = db.all(CHANGE_SQL + "WHERE c.comparison_id=? AND c.page_index=? ORDER BY c.region_no",
                          (comparison_id, page))
        return [_change_out(r, row, result) for r in rows]

    @app.patch("/api/changes/{change_id}", response_model=S.ChangeOut)
    def patch_change(change_id: str, body: S.ChangePatch) -> S.ChangeOut:
        r = db.one(CHANGE_SQL + "WHERE c.id=?", (_id(change_id, "변경 영역"),))
        if r is None:
            raise HTTPException(404, "변경 영역을 찾을 수 없습니다")
        cmp_row, result = _done_cmp(r["comparison_id"])
        if cmp_row["review_completed_at"]:
            raise HTTPException(409, "검토 완료된 비교입니다. 먼저 검토 완료를 해제하세요")
        st = body.status if body.status is not None else r["status"]
        comment = body.comment if body.comment is not None else r["comment"]
        reviewer = body.reviewer if body.reviewer is not None else r["reviewer"]
        ts = now_iso()
        undismiss = bool(r["dismissed_at"]) and st != "No Change"
        with db.tx() as c:
            c.execute("UPDATE reviews SET status=?, comment=?, reviewer=?, reviewed_at=? WHERE change_id=?",
                      (st, comment, reviewer, ts, change_id))
            if undismiss:            # 삭제된 영역을 다른 판정으로 바꾸면 화면에 다시 표시
                c.execute("UPDATE reviews SET dismissed_at=NULL, dismissed_by=NULL, dismissed_prev_status=NULL "
                          "WHERE change_id=?", (change_id,))
            c.execute("INSERT INTO review_history(change_id, status, comment, reviewer, changed_at, action) "
                      "VALUES (?,?,?,?,?,?)", (change_id, st, comment, reviewer, ts,
                                               "restore_by_review" if undismiss else "review"))
        return _change_out(db.one(CHANGE_SQL + "WHERE c.id=?", (change_id,)), cmp_row, result)

    # ------------------------------------------------------------------ 오른쪽 클릭 삭제 (변경 없음) / 복원
    # 자동 탐지 결과(changes 표)는 지우지 않는다. 사용자 판정을 'No Change' 로 바꾸고 삭제 표시만 남긴다.
    def _editable_change(change_id: str) -> tuple[Any, Any, dict[str, Any]]:
        r = db.one(CHANGE_SQL + "WHERE c.id=?", (_id(change_id, "변경 영역"),))
        if r is None:
            raise HTTPException(404, "변경 영역을 찾을 수 없습니다")
        cmp_row, result = _done_cmp(r["comparison_id"])
        if cmp_row["review_completed_at"]:
            raise HTTPException(409, "검토 완료된 비교입니다. 먼저 검토 완료를 해제하세요")
        return r, cmp_row, result

    @app.post("/api/changes/{change_id}/dismiss", response_model=S.ChangeOut)
    def dismiss_change(change_id: str, body: S.DismissIn) -> S.ChangeOut:
        r, cmp_row, result = _editable_change(change_id)
        if r["dismissed_at"]:
            raise HTTPException(409, "이미 삭제된 영역입니다")
        ts = now_iso()
        who = body.reviewer if body.reviewer is not None else r["reviewer"]
        with db.tx() as c:
            c.execute("UPDATE reviews SET status='No Change', reviewer=?, reviewed_at=?, dismissed_at=?, dismissed_by=?, "
                      "dismissed_prev_status=? WHERE change_id=?", (who, ts, ts, who, r["status"], change_id))
            c.execute("INSERT INTO review_history(change_id, status, comment, reviewer, changed_at, action) "
                      "VALUES (?,?,?,?,?,?)", (change_id, "No Change", r["comment"], who, ts, "user_delete"))
        log.info("change %s dismissed (user delete -> No Change)", change_id)
        return _change_out(db.one(CHANGE_SQL + "WHERE c.id=?", (change_id,)), cmp_row, result)

    @app.post("/api/changes/{change_id}/restore", response_model=S.ChangeOut)
    def restore_change(change_id: str, body: S.DismissIn) -> S.ChangeOut:
        r, cmp_row, result = _editable_change(change_id)
        if not r["dismissed_at"]:
            raise HTTPException(409, "삭제된 영역이 아닙니다")
        ts = now_iso()
        who = body.reviewer if body.reviewer is not None else r["reviewer"]
        prev = r["dismissed_prev_status"] or "Unreviewed"            # 삭제 직전 판정으로 되돌림
        with db.tx() as c:
            c.execute("UPDATE reviews SET status=?, reviewer=?, reviewed_at=?, dismissed_at=NULL, dismissed_by=NULL, "
                      "dismissed_prev_status=NULL WHERE change_id=?", (prev, who, ts, change_id))
            c.execute("INSERT INTO review_history(change_id, status, comment, reviewer, changed_at, action) "
                      "VALUES (?,?,?,?,?,?)", (change_id, prev, r["comment"], who, ts, "restore"))
        log.info("change %s restored -> %s", change_id, prev)
        return _change_out(db.one(CHANGE_SQL + "WHERE c.id=?", (change_id,)), cmp_row, result)

    HISTORY_LABEL = {"review": "판정 변경", "user_delete": "사용자 삭제 (변경 없음)", "restore": "삭제 복원",
                     "restore_by_review": "판정 변경 (삭제 해제)"}

    @app.get("/api/changes/{change_id}/history", response_model=list[S.HistoryOut])
    def change_history(change_id: str) -> list[S.HistoryOut]:
        r = db.one("SELECT id FROM changes WHERE id=?", (_id(change_id, "변경 영역"),))
        if r is None:
            raise HTTPException(404, "변경 영역을 찾을 수 없습니다")
        return [S.HistoryOut(action=h["action"], status=h["status"], comment=h["comment"], reviewer=h["reviewer"],
                             changed_at=_dt(h["changed_at"]), label=HISTORY_LABEL.get(h["action"], h["action"]))
                for h in db.all("SELECT * FROM review_history WHERE change_id=? ORDER BY id", (change_id,))]

    # ------------------------------------------------------------------ images (저장된 결과로만 그림, 재비교 없음)
    def _png(arr: np.ndarray, scale: float) -> bytes:
        im = Image.fromarray(arr)
        if scale < 1.0:
            w, h = max(1, round(im.width * scale)), max(1, round(im.height * scale))
            im = im.resize((w, h), Image.Resampling.BOX)
        buf = io.BytesIO()
        im.save(buf, format="PNG", compress_level=1)
        return buf.getvalue()

    @app.get("/api/comparisons/{comparison_id}/pages/{page}/image")
    def page_image(comparison_id: str, page: int, layer: Literal["old", "old_aligned", "new", "overlay"],
                   old: Optional[str] = None, new: Optional[str] = None, changed: Optional[str] = None,
                   scale: float = Query(1.0, gt=0.0, le=1.0)) -> Response:
        row, result = _done_cmp(comparison_id)
        pg = _page(result, page)
        pd = storage.page_dir(comparison_id, page)
        arr: Optional[np.ndarray] = None
        if layer == "overlay":
            base = json.loads(row["settings_json"])["colors"]
            try:
                colors = {"old": E.parse_hex_color(old or base["old"]), "new": E.parse_hex_color(new or base["new"]),
                          "changed": E.parse_hex_color(changed or base["changed"])}
            except ValueError as e:
                raise HTTPException(422, str(e))
            cache_key = "overlay_" + "_".join(colors[k].lstrip("#") for k in ("old", "new", "changed"))
        else:
            if layer == "old_aligned" and not (pd / "old_aligned.png").exists():
                raise HTTPException(404, "정렬 적용 Old 이미지가 없습니다 (정렬 미채택 또는 재현 불일치)")
            cache_key = layer
        cache = pd / "cache" / f"{cache_key}_{scale:.4f}.png"
        if cache.exists():
            return FileResponse(cache, media_type="image/png")
        if layer == "overlay":
            if colors == base:
                arr = load_rgb_png(pd / "overlay_default.png")
            else:   # 색만 바뀜: 저장된 마스크로 엔진 make_overlay 재합성 (비교 재실행 아님)
                m = _masks(comparison_id, pg)
                arr = E.make_overlay(m["old"], m["new"], colors)
        else:
            arr = load_rgb_png(pd / f"{layer}.png")
        data = _png(arr, scale)
        cache.parent.mkdir(exist_ok=True)
        tmp = cache.with_suffix(f".{uuid.uuid4().hex}.tmp")
        tmp.write_bytes(data)
        os.replace(tmp, cache)
        return Response(data, media_type="image/png")

    @app.get("/api/comparisons/{comparison_id}/pages/{page}/region")
    def page_region(comparison_id: str, page: int, which: Literal["old", "new"],
                    ox: int, oy: int, w_px: int = Query(..., ge=16, le=4000),
                    h_px: int = Query(..., ge=16, le=3000),
                    mag: float = Query(E.CARD_MAG_DEFAULT, ge=E.CARD_MAG_MIN, le=E.CARD_MAG_MAX)) -> Response:
        """기존 '비교 돋보기': 원본 PDF 에서 해당 영역만 재렌더 (Old 는 채택된 정렬 적용).
        (ox, oy) 는 엔진 card_region_origin 으로 구한 출력 좌표계 원점."""
        row, result = _done_cmp(comparison_id)
        pg = _page(result, page)
        exists = pg["old_exists"] if which == "old" else pg["new_exists"]
        did = row["baseline_doc_id"] if which == "old" else row["comparison_doc_id"]
        doc = E.fitz.open(stream=storage.upload_path(did).read_bytes(), filetype="pdf")
        try:
            if which == "new":
                arr = E.render_pt_region(doc if exists else None, page, ox, oy, mag, w_px, h_px)
            else:
                al = pg["alignment"]
                inv = np.array(al["inverse"], np.float64) if (al["inverse"] is not None and al["engine_adopted"]) else None
                dpi = json.loads(row["settings_json"])["dpi"]
                arr = E.render_old_aligned_region(doc if exists else None, page, ox, oy, mag, w_px, h_px, dpi, inv)
        finally:
            doc.close()
        return Response(_png(arr, 1.0), media_type="image/png")

    @app.get("/api/comparisons/{comparison_id}/pages/{page}/card_regions", response_model=S.CardRegionsOut)
    def card_regions(comparison_id: str, page: int, ox: int, oy: int, w_px: int = Query(..., ge=16, le=4000),
                     h_px: int = Query(..., ge=16, le=3000),
                     mag: float = Query(..., ge=E.CARD_MAG_MIN, le=E.CARD_MAG_MAX)) -> S.CardRegionsOut:
        """비교 돋보기 안의 변경 박스: 기존 CompareCard.render 와 같은 계산 (gap 0.8mm, min_pixels 1, 300곳까지)."""
        row, result = _done_cmp(comparison_id)
        pg = _page(result, page)
        dpi = json.loads(row["settings_json"])["dpi"]
        m = _masks(comparison_id, pg)
        k = dpi / 72.0
        H, W = m["old"].shape
        rx0, ry0 = max(0, int(np.floor(ox / mag * k))), max(0, int(np.floor(oy / mag * k)))
        rx1, ry1 = min(W, int(np.ceil((ox + w_px) / mag * k))), min(H, int(np.ceil((oy + h_px) / mag * k)))
        if rx1 <= rx0 or ry1 <= ry0:
            return S.CardRegionsOut(regions=[], total=0)
        regs = E.find_change_regions(m["old"][ry0:ry1, rx0:rx1], m["new"][ry0:ry1, rx0:rx1], dpi,
                                     gap_mm=0.8, min_pixels=1, offset=(rx0, ry0))
        return S.CardRegionsOut(regions=[S.BBox(x0=r.x0, y0=r.y0, x1=r.x1, y1=r.y1) for r in regs[:300]],
                                total=len(regs))

    @app.get("/api/comparisons/{comparison_id}/pages/{page}/bubbles", response_model=list[S.BubbleOut])
    def bubbles(comparison_id: str, page: int, zoom: float = Query(..., gt=0, le=E_ZOOM_MAX)) -> list[S.BubbleOut]:
        """변경 알림(숫자): 기존 place_bubbles 로 버블 위치 계산 (화면 배율에 따라 달라짐)."""
        row, result = _done_cmp(comparison_id)
        pg = _page(result, page)
        regs = _engine_changes(comparison_id, page)
        if not regs or len(regs) > E.BUBBLE_MAX_DISPLAY:
            return []
        m = _masks(comparison_id, pg)
        if "ii" not in m:
            ink_ds, block = E.build_ink_summary(m["old"] | m["new"], json.loads(row["settings_json"])["dpi"])
            m["ii"], m["block"] = E.make_integral(ink_ds), block
        W, H = pg["size_px"]
        pl = E.place_bubbles(regs, m["ii"], m["block"], E.BUBBLE_RADIUS_PX / zoom, W, H)
        return [S.BubbleOut(region_no=b.region_id, cx=b.cx, cy=b.cy, clear=b.clear) for b in pl]

    # ------------------------------------------------------------------ markups (New 기준, 엔진 Markup 모델)
    @app.get("/api/comparisons/{comparison_id}/pages/{page}/markups", response_model=S.PageMarkupsOut)
    def get_markups(comparison_id: str, page: int) -> S.PageMarkupsOut:
        _, result = _done_cmp(comparison_id)
        _page(result, page)
        r = db.one("SELECT * FROM markups WHERE comparison_id=? AND page_index=?", (comparison_id, page))
        items = json.loads(r["markups_json"]) if r else []
        return S.PageMarkupsOut(comparison_id=comparison_id, page_index=page,
                                markups=[S.MarkupOut(**m) for m in items], updated_at=_dt(r["updated_at"]) if r else None)

    @app.put("/api/comparisons/{comparison_id}/pages/{page}/markups", response_model=S.PageMarkupsOut)
    def put_markups(comparison_id: str, page: int, body: S.MarkupsPut) -> S.PageMarkupsOut:
        _, result = _done_cmp(comparison_id)
        pg = _page(result, page)
        if not pg["new_exists"] and body.markups:
            raise HTTPException(422, E.POLICY_REASON["blank"])
        items, errors = [], []
        for i, m in enumerate(body.markups, start=1):
            style, errs = E.validate_style(m.style, m.kind)
            geo = A.markup_geometry_error(m.kind, m.pts)
            if geo:
                errs.append(geo)
            if errs:
                errors.append(f"{i}번 {E.TOOL_LABEL[m.kind]}: " + "; ".join(errs))
            items.append({"kind": m.kind, "pts": m.pts, "text": m.text if m.kind in E.TEXT_TOOLS else "",
                          "style": style})
        if errors:
            raise HTTPException(422, errors)
        db.run("INSERT INTO markups VALUES (?,?,?,?) ON CONFLICT(comparison_id, page_index) DO UPDATE SET "
               "markups_json=excluded.markups_json, updated_at=excluded.updated_at",
               (comparison_id, page, dumps(items), now_iso()))
        return get_markups(comparison_id, page)

    def _all_markups(cid: str) -> dict[int, list[dict[str, Any]]]:
        return {r["page_index"]: json.loads(r["markups_json"])
                for r in db.all("SELECT * FROM markups WHERE comparison_id=?", (cid,))}

    # ------------------------------------------------------------------ export
    def _export_out(r: Any) -> S.ExportOut:
        return S.ExportOut(id=r["id"], comparison_id=r["comparison_id"], kind=r["kind"], file_name=r["file_name"],
                           size_bytes=r["size_bytes"], sha256=r["sha256"], created_at=_dt(r["created_at"]),
                           verification=json.loads(r["verification_json"]) if r["verification_json"] else None,
                           download_url=f"/api/exports/{r['id']}/download")

    def _result_json(row: Any) -> dict[str, Any]:
        hist = [{**dict(h), "label": HISTORY_LABEL.get(h["action"], h["action"])} for h in db.all(
            "SELECT h.* FROM review_history h JOIN changes c ON c.id=h.change_id WHERE c.comparison_id=? "
            "ORDER BY h.id", (row["id"],))]
        runs = [dict(r) for r in db.all("SELECT * FROM ai_runs WHERE comparison_id=? ORDER BY created_at", (row["id"],))]
        return {"format": "drawing-auto-comparison/result", "format_version": 3, "exported_at": now_iso(),
                "dismissed_count": db.one("SELECT COUNT(*) n FROM reviews v JOIN changes c ON c.id=v.change_id "
                                          "WHERE c.comparison_id=? AND v.dismissed_at IS NOT NULL", (row["id"],))["n"],
                "comparison": _cmp_out(row).model_dump(mode="json"),
                "changes": [c.model_dump(mode="json") for c in list_changes(row["id"])],
                "review_history": hist, "ai_runs": runs,
                "review_snapshot_at_completion": json.loads(row["review_snapshot_json"])
                if row["review_snapshot_json"] else None,
                "markups": {str(k): v for k, v in _all_markups(row["id"]).items()}}

    @app.post("/api/comparisons/{comparison_id}/export", response_model=S.ExportOut, status_code=201)
    def export(comparison_id: str, body: S.ExportCreate) -> S.ExportOut:
        row, result = _done_cmp(comparison_id)
        eid = uuid.uuid4().hex
        old_name = _doc(row["baseline_doc_id"])["original_name"]
        new_name = _doc(row["comparison_doc_id"])["original_name"]
        markups = A.to_engine_markups(_all_markups(comparison_id)) if body.include_markups else {}
        verification: Optional[dict[str, Any]] = None
        try:
            if body.kind == "overlay_pdf":
                st = json.loads(row["settings_json"])
                colors = body.colors.model_dump() if body.colors else st["colors"]
                pages = _engine_pages(row, result, with_new_img=True)
                res = E.ComparisonResult(pages, st["dpi"], "", "", b"", b"", "", "", st["auto_align"], st["tol_mm"])
                out = storage.export_path(eid, ".pdf")
                verification = E.save_overlay_pdf(res, colors, markups, str(out))
                fname = f"{Path(old_name).stem}_compare_result.pdf"          # 기존 프로그램 기본 이름
            elif body.kind == "new_pdf":
                out = storage.export_path(eid, ".pdf")
                verification = E.save_new_pdf(storage.upload_path(row["comparison_doc_id"]).read_bytes(),
                                              markups, str(out))
                fname = f"{Path(new_name).stem}_markup.pdf"                 # 사용자 승인 (2026-11-09)
            else:
                out = storage.export_path(eid, ".json")
                out.write_text(json.dumps(_result_json(row), ensure_ascii=False, indent=1), encoding="utf-8")
                fname = f"{Path(old_name).stem}_compare_result.json"
        except E.SaveError as e:
            log.warning("export %s failed comparison=%s: %s", body.kind, comparison_id, e)
            raise HTTPException(422, f"저장 실패: {e}")
        data = out.read_bytes()
        db.run("INSERT INTO exports VALUES (?,?,?,?,?,?,?,?,?)",
               (eid, comparison_id, body.kind, out.name, sanitize_display_name(fname), len(data),
                hashlib.sha256(data).hexdigest(), now_iso(), dumps(verification) if verification else None))
        return _export_out(db.one("SELECT * FROM exports WHERE id=?", (eid,)))

    @app.get("/api/comparisons/{comparison_id}/exports", response_model=list[S.ExportOut])
    def list_exports(comparison_id: str) -> list[S.ExportOut]:
        _cmp(comparison_id)
        return [_export_out(r) for r in db.all("SELECT * FROM exports WHERE comparison_id=? ORDER BY created_at DESC",
                                               (comparison_id,))]

    @app.get("/api/exports/{export_id}/download")
    def download(export_id: str) -> FileResponse:
        r = _row("exports", export_id, "내보내기 파일")
        path = storage.root / "exports" / r["stored_name"]
        media = "application/pdf" if r["stored_name"].endswith(".pdf") else "application/json"
        return FileResponse(path, media_type=media, headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(r['file_name'])}"})

    # ------------------------------------------------------------------ AI 검증 (기존 4-b부 그대로 호출)
    # 순서도 기존과 같다: 작업 생성 → 비용 추정 → 사용자 확인 → 호출. 결과는 제안이며 비교 결과를 바꾸지 않는다.
    @app.get("/api/ai/status", response_model=S.AiStatusOut)
    def ai_status() -> S.AiStatusOut:
        avail = E.ai_available()
        has_key = False
        if avail:
            try:
                has_key = bool(E.ai_get_key())
            except Exception:
                has_key = False
        return S.AiStatusOut(available=avail, enabled=_ai_enabled(), has_key=has_key, model=E.AI_MODEL)

    @app.post("/api/ai/key", response_model=S.AiStatusOut)
    def ai_key(body: S.AiKeyIn) -> S.AiStatusOut:
        if not E.ai_available():
            raise HTTPException(409, "anthropic·keyring 미설치 – AI 검증을 사용할 수 없습니다")
        try:
            E.ai_set_key(body.key)               # Windows 자격 증명 관리자(keyring)에만 저장. 로그에 남기지 않음
        except ValueError as e:
            raise HTTPException(422, f"{e} 저장하지 않았습니다.")
        except Exception as e:
            raise HTTPException(500, f"키를 저장하지 못했습니다: {type(e).__name__}")
        return ai_status()

    def _ai_run_out(r: Any) -> S.AiRunOut:
        text = (f"변경 영역 {r['n_regions']}개를 {r['model']} 로 검증합니다.\n\n"
                f"입력 약 {r['input_tokens']:,} 토큰 · 예상 비용 약 ${r['est_cost_usd']:.2f} (실제와 다를 수 있음)\n\n"
                "변경 영역 주변의 도면 이미지가 Anthropic으로 전송됩니다.\n"
                "결과는 제안이며 비교 결과를 바꾸지 않습니다.")
        return S.AiRunOut(id=r["id"], comparison_id=r["comparison_id"], state=r["state"], model=r["model"],
                          n_regions=r["n_regions"], n_jobs=r["n_jobs"], input_tokens=r["input_tokens"],
                          est_cost_usd=r["est_cost_usd"], jobs_done=r["jobs_done"], results=r["results"],
                          error=r["error"], confirm_text=text, created_at=_dt(r["created_at"]))

    @app.post("/api/comparisons/{comparison_id}/ai/estimate", response_model=S.AiRunOut, status_code=201)
    def ai_estimate(comparison_id: str) -> S.AiRunOut:
        row, result = _done_cmp(comparison_id)
        if not E.ai_available():
            raise HTTPException(409, "anthropic·keyring 미설치 – AI 검증을 사용할 수 없습니다")
        if not _ai_enabled():
            raise HTTPException(409, "메뉴에서 'AI 사용 (Claude API)'을 먼저 체크하세요")
        if db.one("SELECT 1 FROM ai_runs WHERE comparison_id=? AND state IN ('estimated','running')", (comparison_id,)):
            raise HTTPException(409, "이 비교의 AI 검증이 이미 진행 중입니다")
        pages = _engine_pages(row, result)
        if not any(p.changes for p in pages):
            raise HTTPException(409, "검증할 변경 영역이 없습니다.")
        done = {(r["page_index"], r["region_no"]) for r in db.all(
            "SELECT c.page_index, c.region_no FROM ai_results a JOIN changes c ON c.id=a.change_id "
            "WHERE c.comparison_id=?", (comparison_id,))}
        if not E.ai_pending_regions(pages, done):          # 이미 받은 결과는 다시 요청하지 않는다(비용 없음)
            raise HTTPException(409, "모든 변경 영역이 이미 검증되어 있습니다 (추가 비용 없음)")
        try:
            client = E.ai_make_client()
            jobs = E.ai_build_jobs(pages, done)
            tokens, cost = E.ai_estimate(client, jobs)
        except E.AiError as e:
            raise HTTPException(422, str(e))
        except Exception as e:
            log.warning("ai estimate failed comparison=%s: %s", comparison_id, type(e).__name__)
            raise HTTPException(422, f"AI 요청 실패: {e}")
        rid = uuid.uuid4().hex
        n = sum(len(j["items"]) for j in jobs)
        db.run("INSERT INTO ai_runs(id, comparison_id, state, model, n_regions, n_jobs, input_tokens, est_cost_usd, "
               "created_at) VALUES (?,?,?,?,?,?,?,?,?)",
               (rid, comparison_id, "estimated", E.AI_MODEL, n, len(jobs), int(tokens), float(cost), now_iso()))
        ai_pending[rid] = (client, jobs)
        log.info("ai estimate %s comparison=%s regions=%d jobs=%d tokens=%d", rid, comparison_id, n, len(jobs), tokens)
        return _ai_run_out(db.one("SELECT * FROM ai_runs WHERE id=?", (rid,)))

    def _ai_worker(rid: str, cid: str, client: Any, jobs: list[dict[str, Any]]) -> None:
        got = 0
        for i, job in enumerate(jobs, start=1):
            try:
                out = E.ai_call(client, job)
            except Exception as e:                           # 받은 결과는 유지하고, 다시 누르면 남은 영역만 요청
                log.warning("ai run %s failed at job %d: %s", rid, i, type(e).__name__)
                db.run("UPDATE ai_runs SET state='failed', error=?, finished_at=? WHERE id=?",
                       (str(e), now_iso(), rid))
                return
            with db.tx() as c:
                for (page, region_no), v in out.items():
                    ch = c.execute("SELECT id FROM changes WHERE comparison_id=? AND page_index=? AND region_no=?",
                                   (cid, page, region_no)).fetchone()
                    if ch is None:
                        continue
                    c.execute("INSERT OR REPLACE INTO ai_results VALUES (?,?,?,?,?)",
                              (ch["id"], v["result"], v["summary"], E.AI_MODEL, now_iso()))
                    got += 1
                c.execute("UPDATE ai_runs SET jobs_done=?, results=? WHERE id=?", (i, got, rid))
        db.run("UPDATE ai_runs SET state='succeeded', finished_at=? WHERE id=?", (now_iso(), rid))

    def _ai_run_row(rid: str) -> Any:
        return _row("ai_runs", rid, "AI 검증 작업")

    @app.post("/api/ai/runs/{run_id}/start", response_model=S.AiRunOut)
    def ai_start(run_id: str) -> S.AiRunOut:
        r = _ai_run_row(run_id)
        if r["state"] != "estimated" or run_id not in ai_pending:
            raise HTTPException(409, f"시작할 수 없는 상태입니다 ({r['state']})")
        if not _ai_enabled():
            raise HTTPException(409, "메뉴에서 'AI 사용 (Claude API)'을 먼저 체크하세요")
        client, jobs = ai_pending.pop(run_id)
        db.run("UPDATE ai_runs SET state='running', started_at=? WHERE id=?", (now_iso(), run_id))
        threading.Thread(target=_ai_worker, args=(run_id, r["comparison_id"], client, jobs), daemon=True).start()
        return _ai_run_out(_ai_run_row(run_id))

    @app.post("/api/ai/runs/{run_id}/cancel", response_model=S.AiRunOut)
    def ai_cancel(run_id: str) -> S.AiRunOut:
        r = _ai_run_row(run_id)
        if r["state"] != "estimated":
            raise HTTPException(409, f"취소할 수 없는 상태입니다 ({r['state']})")
        ai_pending.pop(run_id, None)
        db.run("UPDATE ai_runs SET state='cancelled', finished_at=? WHERE id=?", (now_iso(), run_id))
        return _ai_run_out(_ai_run_row(run_id))

    @app.get("/api/ai/runs/{run_id}", response_model=S.AiRunOut)
    def ai_run(run_id: str) -> S.AiRunOut:
        return _ai_run_out(_ai_run_row(run_id))

    # ------------------------------------------------------------------ 빌드된 화면 (창 1개 실행)
    if cfg.static_dir is not None:
        app.mount("/", StaticFiles(directory=str(cfg.static_dir), html=True), name="ui")

    return app


E_ZOOM_MAX = 1000.0
app = create_app()
