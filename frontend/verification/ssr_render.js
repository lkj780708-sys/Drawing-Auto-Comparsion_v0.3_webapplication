// React 서버 렌더로 컴포넌트가 실제 데이터로 오류 없이 그려지는지 확인 (상호작용은 검증 불가)
require("./nextshim/hook.js");
const R = require("react");
const { renderToString } = require("react-dom/server");
const fs = require("fs");
const assert = require("assert");
const { api } = require("@/lib/api");
const SP = require("@/components/SidePanels");
const { DrawingPane } = require("@/components/DrawingViewer");
const { fitView } = require("@/lib/geometry");
const pages = {
  home: require("@/app/page").default,
  project: require("@/components/ProjectWorkspace").ProjectWorkspace,
  cmp: require("@/components/ComparisonWorkspace").ComparisonWorkspace,
};
const ids = JSON.parse(fs.readFileSync("it_ids.json", "utf8"));
const noop = () => {};
const h = R.createElement;
(async () => {
  const c = await api.getComparison(ids.comparison);
  const ch = await api.listChanges(ids.comparison);
  const mk = (await api.getMarkups(ids.comparison, 0)).markups;
  const d = await api.defaults();
  const out = {};
  out.home = renderToString(h(pages.home));
  out.project = renderToString(h(pages.project, { projectId: ids.project }));
  out.cmp = renderToString(h(pages.cmp, { comparisonId: ids.comparison }));
  out.align = renderToString(h(SP.AlignmentPanel, { page: c.pages[0] }));
  out.list = renderToString(h(SP.ChangeList, { changes: ch, selectedId: ch[0].change_id, onSelect: noop, filter: "all", setFilter: noop }));
  out.review = renderToString(h(SP.ReviewPanel, { change: ch[0], locked: true, reviewer: "KJ", setReviewer: noop, onSaved: noop }));
  out.mag = renderToString(h(SP.Magnifier, { comparisonId: c.id, change: ch[0], pageIndex: 0 }));
  out.props = renderToString(h(SP.MarkupProps, { markup: mk[1], onChange: noop, onDelete: noop }));
  out.export = renderToString(h(SP.ReviewAndExport, { cmp: c, colors: c.settings.colors, reviewer: "KJ", markupsDirty: true, onCmp: noop }));
  const [W, H] = c.pages[0].size_px;
  out.pane = renderToString(h(DrawingPane, {
    label: "OVERLAY", src: "x.png", imgW: W, imgH: H, dpi: c.settings.dpi, view: fitView(W, H, 1600, 1000),
    onView: noop, changes: ch, boxMode: "all", boxColor: "#E0245E", selectedChangeId: ch[0].change_id, onSelectChange: noop,
    markups: mk, markupsEditable: true, tool: "select", toolStyle: (k) => d.tool_defaults[k], selectedMarkup: 1,
    onSelectMarkup: noop, onMarkupsChange: noop, onCursor: noop, fitSignal: 0,
  }));
  const count = (s, re) => (s.match(re) || []).length;
  console.log("home        ", out.home.length, "bytes; 로딩 표시:", out.home.includes("불러오는 중"));
  console.log("project     ", out.project.length, "bytes; 업로드 슬롯:", count(out.project, /PDF를 끌어놓거나/g));
  console.log("comparison  ", out.cmp.length, "bytes; 로딩 표시:", out.cmp.includes("불러오는 중"));
  console.log("align       ", out.align.includes("정렬 성공"), "| list rows:", count(out.list, /<tr class="cursor-pointer/g), "| review 잠금 문구:", out.review.includes("검토 완료 상태"));
  console.log("magnifier   ", count(out.mag, /<img /g), "img | markup props 글자:", out.props.includes("검토: 변경 확인"), "| export 경고:", out.export.includes("저장하지 않은 마크업"));
  console.log("pane        boxes(rect+text):", count(out.pane, /<g><rect/g), "markups polygon:", count(out.pane, /<polygon/g), "foreignObject:", count(out.pane, /<foreignObject/g), "선택 점선:", count(out.pane, /stroke-dasharray/g));
  assert.equal(count(out.list, /<tr class="cursor-pointer/g), 39);
  fs.writeFileSync("pane.html", `<html><body style="margin:0;width:1600px;height:1000px">${out.pane}</body></html>`);
  console.log("SSR PASS");
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
