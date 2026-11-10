// 실제 FastAPI 서버에 프론트엔드 lib/api.ts(트랜스파일본)로 전체 Workflow 실행
require("./nextshim/hook.js");
const fs = require("fs");
const assert = require("assert");
const { api, pageImageUrl, regionUrl, downloadUrl, ApiError } = require("@/lib/api");
const S = "/home/claude/dac/samples/";
const file = (n) => new File([fs.readFileSync(S + n)], n, { type: "application/pdf" });
(async () => {
  const t0 = Date.now();
  const d = await api.defaults();
  assert.equal(d.dpi, 288); assert.equal(d.tol_mm, 0.5);
  const p = await api.createProject("IT P&ID", "integration");
  const o = await api.uploadDocument(p.id, file("PID_r04.pdf"));
  const n = await api.uploadDocument(p.id, file("PID_r06.pdf"));
  try { await api.uploadDocument(p.id, new File([Buffer.from("PK\x03\x04xx")], "x.pdf")); assert.fail("must reject"); }
  catch (e) { assert(e instanceof ApiError && e.status === 422); console.log("가짜 PDF 거부:", e.detail); }
  let j = await api.createComparison({ project_id: p.id, baseline_document_id: o.id, comparison_document_id: n.id, dpi: d.dpi, auto_align: d.auto_align, tol_mm: d.tol_mm, colors: d.colors });
  const stages = [];
  while (j.state === "queued" || j.state === "running") { await new Promise(r => setTimeout(r, 300)); j = await api.getStatus(j.id); if (stages.at(-1) !== j.stage) stages.push(j.stage); }
  console.log("진행 단계:", stages.join(" → "));
  assert.equal(j.state, "succeeded");
  const c = await api.getComparison(j.id);
  const ch = await api.listChanges(j.id);
  console.log("정렬:", c.overall_alignment_status, "변경 영역:", ch.length, "Unreviewed:", c.review_summary.Unreviewed);
  assert.equal(ch.length, 39);
  // 이미지 (표시 모드별) – 재비교 없이 저장 결과
  for (const layer of ["old", "new", "overlay"]) {
    const r = await fetch(pageImageUrl(j.id, 0, layer, 0.5, layer === "overlay" ? { old: "#A0A0A0", new: "#000000", changed: "#17BF63" } : undefined));
    assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/png");
  }
  const al = await fetch(pageImageUrl(j.id, 0, "old_aligned", 0.5));
  console.log("old_aligned (정렬 미채택 비교):", al.status, c.pages[0].old_aligned.note);
  const b = ch[0].detection.bounding_box_pt;
  for (const w of ["old", "new"]) {
    const r = await fetch(regionUrl(j.id, 0, w, (b.x0 + b.x1) / 2 - 340 / 2 / 4, (b.y0 + b.y1) / 2 - 200 / 2 / 4, 340, 200, 4));
    assert.equal(r.status, 200, `region ${w}`);
  }
  const edge = await fetch(regionUrl(j.id, 0, "old", -20, -20, 340, 200, 4));   // 페이지 밖 좌표 (좌상단 영역)
  console.log("돋보기 페이지 밖 좌표:", edge.status);
  // 판정 (자동 탐지와 분리)
  const r1 = await api.patchChange(ch[0].change_id, { status: "Confirmed Change", comment: "NOTE 변경 확인", reviewer: "KJ" });
  assert.deepEqual(r1.detection, ch[0].detection);
  await api.patchChange(ch[1].change_id, { status: "False Positive", reviewer: "KJ" });
  // 마크업 (뷰어가 만드는 형태 그대로)
  const st = d.tool_defaults;
  const mk = [
    { kind: "cloud", pts: [[b.x0 - 5, b.y0 - 5], [b.x1 + 5, b.y1 + 5]], text: "", style: { ...st.cloud } },
    { kind: "callout", pts: [[b.x1 + 20, b.y0 - 40], [b.x1 + 140, b.y0 - 10], [b.x1, b.y0]], text: "검토: 변경 확인", style: { ...st.callout } },
    { kind: "arrow", pts: [[100, 100], [160, 140]], text: "", style: { ...st.arrow } },
    { kind: "polygon", pts: [[200, 200], [260, 200], [230, 240]], text: "", style: { ...st.polygon, fill: "#FFFF00" } },
  ];
  try { await api.putMarkups(j.id, 0, [{ ...mk[0], style: { ...st.cloud, width: 99 } }]); assert.fail(); }
  catch (e) { console.log("잘못된 마크업 거부:", e.detail.replace(/\n/g, " ")); }
  const pm = await api.putMarkups(j.id, 0, mk);
  assert.equal(pm.markups.length, 4);
  for (const k of ["overlay_pdf", "new_pdf", "result_json"]) {
    const ex = await api.createExport(j.id, k, k === "overlay_pdf" ? d.colors : null, true);
    const r = await fetch(downloadUrl(ex.download_url));
    const buf = Buffer.from(await r.arrayBuffer());
    console.log(`내보내기 ${k}: ${ex.file_name} ${Math.round(ex.size_bytes / 1024)}KB 검증=${JSON.stringify(ex.verification)} 다운로드=${r.status} ${buf.length === ex.size_bytes ? "크기일치" : "크기불일치"}`);
    if (k === "result_json") {
      const js = JSON.parse(buf.toString("utf8"));
      assert.equal(js.changes.length, 39); assert.equal(js.review_history.length, 2);
    }
  }
  const done = await api.setReviewCompleted(j.id, true, "KJ");
  console.log("검토 완료:", done.review_completed_at !== null, "집계:", JSON.stringify(done.review_summary));
  try { await api.patchChange(ch[2].change_id, { status: "No Change" }); assert.fail(); } catch (e) { console.log("완료 후 판정 잠금:", e.status); }
  fs.writeFileSync("it_ids.json", JSON.stringify({ project: p.id, comparison: j.id }));
  console.log("PASS", ((Date.now() - t0) / 1000).toFixed(1) + "s");
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
