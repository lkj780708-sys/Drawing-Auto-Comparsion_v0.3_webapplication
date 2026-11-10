"""실제 uvicorn 서버에 HTTP 로 요청해 비동기 흐름(202 → status 폴링 → 결과)을 확인."""
import json, sys, time
from pathlib import Path
import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
SAMPLES = Path(__file__).resolve().parents[2] / "samples"
c = httpx.Client(base_url=BASE, timeout=120)
pid = c.post("/api/projects", json={"name": "smoke"}).json()["id"]
ids = []
for f in ("PID_r04.pdf", "PID_r06.pdf"):
    with open(SAMPLES / f, "rb") as fh:
        ids.append(c.post("/api/documents/upload", data={"project_id": pid}, files={"file": (f, fh, "application/pdf")}).json()["id"])
d = c.get("/api/defaults").json()
t0 = time.perf_counter()
r = c.post("/api/comparisons", json={"project_id": pid, "baseline_document_id": ids[0], "comparison_document_id": ids[1],
                                     "dpi": d["dpi"], "auto_align": d["auto_align"], "tol_mm": d["tol_mm"], "colors": d["colors"]})
print("POST", r.status_code, "in", round(time.perf_counter() - t0, 3), "s", r.json()["state"])
cid = r.json()["id"]; seen = []
while True:
    s = c.get(f"/api/comparisons/{cid}/status").json()
    if not seen or seen[-1] != s["stage"]:
        seen.append(s["stage"])
    if s["state"] in ("succeeded", "failed"):
        break
    time.sleep(0.3)
print("stages:", seen)
print("total wall", round(time.perf_counter() - t0, 2), "s")
cmp_ = c.get(f"/api/comparisons/{cid}").json()
p = cmp_["pages"][0]
print("state", cmp_["state"], "align", p["alignment"]["status"], "changes", p["change_count"], "timing", cmp_["timing_s"])
t1 = time.perf_counter(); img = c.get(f"/api/comparisons/{cid}/pages/0/image?layer=overlay")
print("overlay png", img.status_code, len(img.content) // 1024, "KB", round(time.perf_counter() - t1, 2), "s")
t1 = time.perf_counter(); img = c.get(f"/api/comparisons/{cid}/pages/0/image?layer=overlay")
print("overlay png (cached)", round(time.perf_counter() - t1, 2), "s")
ex = c.post(f"/api/comparisons/{cid}/export", json={"kind": "overlay_pdf"}).json()
dl = c.get(ex["download_url"])
print("export", ex["file_name"], ex["size_bytes"] // 1024, "KB", dl.headers.get("content-disposition"))
