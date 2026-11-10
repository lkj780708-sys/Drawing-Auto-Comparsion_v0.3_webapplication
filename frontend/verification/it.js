const Module = require("module"); require("./hook.js");
const fs = require("fs"); const assert = require("assert");
process.env.NEXT_PUBLIC_API_BASE = "http://127.0.0.1:8000";
delete require.cache[require.resolve("@/lib/api")];
const { api, pageImageUrl, regionUrl, downloadUrl } = require("@/lib/api");
const file = (p, n) => new File([fs.readFileSync(p)], n, { type: "application/pdf" });
(async () => {
  let s = await api.settings(); console.log("settings", s.dpi, s.tol_mm, s.settings_file_exists, "ai_available", s.ai_available);
  s = await api.patchSettings({ dpi: 288, tol_mm: 0.5, menu_pinned: true, menu_width: 420, colors: { old: "#1F6FEB", new: "#000000", changed: "#E0245E" } });
  console.log("saved settings file", fs.existsSync("/home/claude/itdata/settings.json"), s.dpi, s.menu_width);
  const p = await api.createProject("기본 프로젝트");
  const o = await api.uploadDocument(p.id, file("/home/claude/o.pdf", "Rev.A.pdf")); const n = await api.uploadDocument(p.id, file("/home/claude/n.pdf", "Rev.B.pdf"));
  let j = await api.createComparison({ project_id: p.id, baseline_document_id: o.id, comparison_document_id: n.id, dpi: s.dpi, auto_align: s.auto_align, tol_mm: s.tol_mm, colors: s.colors });
  const stages = []; while (j.state === "queued" || j.state === "running") { await new Promise(r => setTimeout(r, 200)); j = await api.getStatus(j.id); if (stages.at(-1) !== j.stage) stages.push(j.stage); }
  console.log("stages", stages.join(" → "));
  const c = await api.getComparison(j.id); const ch = await api.listChanges(j.id);
  console.log("changes", ch.length, c.overall_alignment_status);
  const b = await api.bubbles(j.id, 0, 0.3); console.log("bubbles", b.length, b[0]);
  const cr = await api.cardRegions(j.id, 0, 1800, 400, 600, 300, 4); console.log("card regions", cr.total);
  for (const u of [pageImageUrl(j.id, 0, "overlay", 0.5, s.colors), regionUrl(j.id, 0, "old", 1800, 400, 600, 300, 4)]) assert.equal((await fetch(u)).status, 200);
  await api.putMarkups(j.id, 0, [{ kind: "cloud", pts: [[490, 135], [760, 165]], text: "", style: s.tool_defaults.cloud }]);
  const ex = await api.createExport(j.id, "overlay_pdf", s.colors); const r = await fetch(downloadUrl(ex.download_url));
  console.log("export", ex.file_name, ex.verification, r.status, r.headers.get("content-disposition"));
  const ai = await api.aiStatus(); console.log("ai status", ai);
  try { await api.aiEstimate(j.id); } catch (e) { console.log("ai estimate →", e.status, e.detail); }
  console.log("PASS");
})().catch(e => { console.error("FAIL", e); process.exit(1); });
