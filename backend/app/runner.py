"""비교 작업 실행 (FastAPI BackgroundTasks 에서 호출). 엔진 compare_pdfs 를 그대로 실행하고 결과를 저장한다."""
from __future__ import annotations

import json
import logging
import shutil
import threading
import time
import uuid
from typing import Any

from engine import legacy_v10 as E

from . import engine_adapter as A
from .db import Database, dumps, now_iso
from .storage import Storage, save_mask_png, save_rgb_png

log = logging.getLogger("dac.runner")


class Runner:
    def __init__(self, db: Database, storage: Storage, max_concurrent: int) -> None:
        self.db = db
        self.storage = storage
        self._sem = threading.BoundedSemaphore(max_concurrent)

    def _set(self, cid: str, **kw: Any) -> None:
        cols = ", ".join(f"{k}=?" for k in kw)
        self.db.run(f"UPDATE comparisons SET {cols} WHERE id=?", (*kw.values(), cid))

    def run(self, cid: str) -> None:
        stage = "대기"
        with self._sem:
            try:
                stage = "입력 확인"
                self._set(cid, state="running", stage=stage, started_at=now_iso())
                row = self.db.one("SELECT * FROM comparisons WHERE id=?", (cid,))
                if row is None:
                    raise RuntimeError("비교 요청이 없습니다")
                settings = json.loads(row["settings_json"])
                docs = {}
                for key, did in (("old", row["baseline_doc_id"]), ("new", row["comparison_doc_id"])):
                    d = self.db.one("SELECT * FROM documents WHERE id=?", (did,))
                    data, sha, _n = E.read_pdf_checked(str(self.storage.upload_path(did)))
                    if sha != d["sha256"]:
                        raise RuntimeError(f"저장된 {key} 문서의 SHA-256 이 업로드 시점과 다릅니다")
                    docs[key] = (d, data, sha)

                stage = "비교 엔진 실행"
                self._set(cid, stage=stage)

                def progress(i: int, n: int) -> None:
                    self._set(cid, page_done=i - 1, page_total=n, stage=f"비교 중… ({i}/{n} 페이지)")

                t0 = time.perf_counter()
                res = E.compare_pdfs(docs["old"][1], docs["new"][1], settings["dpi"], settings["auto_align"],
                                     progress=progress, paths=("", ""), shas=(docs["old"][2], docs["new"][2]),
                                     tol_mm=settings["tol_mm"])
                t_cmp = time.perf_counter() - t0
                try:
                    stage = "결과 저장"
                    self._set(cid, stage=stage, page_done=len(res.pages), page_total=len(res.pages))
                    t1 = time.perf_counter()
                    result = self._persist(cid, res, settings, docs)
                    result["timing_s"] = {"comparison": round(t_cmp, 3),
                                          "persist_images": round(time.perf_counter() - t1, 3)}
                finally:
                    res.close()
                n_chg = sum(p["change_count"] for p in result["pages"])
                self._set(cid, state="succeeded", stage=f"비교 완료: {len(result['pages'])}페이지, 변경 영역 {n_chg}개",
                          result_json=dumps(result), finished_at=now_iso())
                log.info("comparison %s succeeded pages=%d changes=%d", cid, len(result["pages"]), n_chg)
            except MemoryError:
                log.exception("comparison %s failed at stage=%s (MemoryError)", cid, stage)
                self._set(cid, state="failed", stage=f"실패: {stage}",   # 기존 프로그램과 같은 안내 문구
                          error="메모리가 부족합니다. DPI를 낮추거나 페이지 수가 적은 PDF로 비교하세요.",
                          finished_at=now_iso())
            except Exception as e:
                log.exception("comparison %s failed at stage=%s", cid, stage)
                self._set(cid, state="failed", stage=f"실패: {stage}", error=f"비교 중 오류: {e}",
                          finished_at=now_iso())

    def _save_old_aligned(self, res: Any, p: Any, settings: dict[str, Any], pd: Any) -> dict[str, Any]:
        """나란히 보기용 '정렬 적용 Old' 이미지 (표시 전용).
        엔진이 쓴 것과 같은 함수·행렬로 다시 만든 뒤, line_mask→apply_tolerance 결과가 엔진 old_mask 와
        바이트까지 같은지 확인한다. 다르면 쓰지 않는다."""
        if not p.align.adopted or p.align.matrix is None:
            return {"available": False, "verified": False, "method": None, "note": "정렬 미채택 – Old 원본 사용"}
        M = p.align.matrix
        shape = p.new_img.shape[:2]
        if "PDF 재렌더" in (p.align.reason or ""):
            method = "render_page_transformed"
            img = E.render_page_transformed(res.doc("old"), p.index, settings["dpi"], M, shape)
        else:
            method = "warpAffine(INTER_NEAREST)"
            H, W = shape
            img = E.cv2.warpAffine(p.old_img, M, (W, H), flags=E.cv2.INTER_NEAREST,
                                   borderMode=E.cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
        om, _ = E.apply_tolerance(E.line_mask(img), E.line_mask(p.new_img),
                                  E.tolerance_px(settings["tol_mm"], settings["dpi"]))
        verified = bool(om.shape == p.old_mask.shape and A.mask_sha(om) == A.mask_sha(p.old_mask))
        if verified:
            save_rgb_png(img, pd / "old_aligned.png")
        else:
            log.warning("page %d old_aligned 재현 불일치 – 표시하지 않음", p.index)
        return {"available": verified, "verified": verified, "method": method,
                "note": "엔진 old_mask 와 일치 확인" if verified else "엔진 결과와 불일치하여 사용하지 않음"}

    def _persist(self, cid: str, res: Any, settings: dict[str, Any], docs: dict[str, Any]) -> dict[str, Any]:
        cdir = self.storage.comparison_dir(cid)
        if cdir.exists():
            shutil.rmtree(cdir)
        old_sizes = json.loads(docs["old"][0]["page_sizes_json"])
        new_sizes = json.loads(docs["new"][0]["page_sizes_json"])
        colors = settings["colors"]
        pages_out: list[dict[str, Any]] = []
        change_rows: list[tuple[Any, ...]] = []
        created = now_iso()
        for p in res.pages:
            pd = self.storage.page_dir(cid, p.index)
            pd.mkdir(parents=True, exist_ok=True)
            save_rgb_png(p.old_img, pd / "old.png")
            save_rgb_png(p.new_img, pd / "new.png")
            save_mask_png(p.old_mask, pd / "old_mask.png")
            save_mask_png(p.new_mask, pd / "new_mask.png")
            save_rgb_png(res.overlay(p.index, colors), pd / "overlay_default.png")
            aligned_info = self._save_old_aligned(res, p, settings, pd)
            osz = tuple(old_sizes[p.index]) if p.old_exists else None
            nsz = tuple(new_sizes[p.index]) if p.new_exists else None
            pages_out.append({
                "page_index": p.index, "size_px": list(p.size_px),
                "old_exists": p.old_exists, "new_exists": p.new_exists,
                "old_page_size_pt": osz, "new_page_size_pt": nsz,
                "stats": p.stats, "change_count": len(p.changes),
                "alignment": A.alignment_status(p.align, p.old_exists, p.new_exists, osz, nsz),
                "mask_sha256": {"old": A.mask_sha(p.old_mask), "new": A.mask_sha(p.new_mask)},
                "old_aligned": aligned_info,
            })
            for r in p.changes:
                change_rows.append((uuid.uuid4().hex, cid, p.index, r.id, r.x0, r.y0, r.x1, r.y1,
                                    r.removed, r.added, created))
        with self.db.tx() as c:
            c.execute("DELETE FROM reviews WHERE change_id IN (SELECT id FROM changes WHERE comparison_id=?)", (cid,))
            c.execute("DELETE FROM changes WHERE comparison_id=?", (cid,))
            c.executemany("INSERT INTO changes VALUES (?,?,?,?,?,?,?,?,?,?,?)", change_rows)
            c.executemany("INSERT INTO reviews(change_id, status) VALUES (?, 'Unreviewed')",
                          [(r[0],) for r in change_rows])
        return {
            "pages": pages_out,
            "thresholds": A.thresholds_snapshot(settings["dpi"], settings["tol_mm"]),
            "engine": A.engine_info(),
            "overall_alignment_status": A.worst_status([pg["alignment"]["status"] for pg in pages_out]),
            "detection_method": A.DETECTION_METHOD,
        }
