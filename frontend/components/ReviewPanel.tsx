"use client";

// 웹 전용 오른쪽 접이식 검토 패널: 변경 영역 목록·판정·Comment / 프로젝트·비교 이력 / 검토 완료·추적 정보.
// 자동 탐지(detection), 사용자 판정(review), AI 제안(ai)은 서로 다른 칸으로 표시한다.
import { useEffect, useState } from "react";
import { api, errText } from "@/lib/api";
import { pxToMm } from "@/lib/geometry";
import type { Change, Comparison, HistoryItem, Project, ReviewStatus } from "@/lib/types";
import { REVIEW_STATUSES } from "@/lib/types";

export const REVIEW_KO: Record<ReviewStatus, { ko: string; key: string; color: string }> = {
  Unreviewed: { ko: "미검토", key: "0", color: "var(--fg2)" },
  "Confirmed Change": { ko: "변경 확인", key: "1", color: "var(--red)" },
  "No Change": { ko: "변경 없음", key: "2", color: "var(--green)" },
  "False Positive": { ko: "오검출", key: "3", color: "var(--purple)" },
  "Needs Review": { ko: "재검토 필요", key: "4", color: "var(--warn)" },
};
const ALIGN_KO = { "Alignment Successful": ["정렬 성공", "var(--green)"], "Alignment Review Required": ["정렬 확인 필요", "var(--warn)"], "Alignment Failed": ["정렬 실패", "var(--red)"] } as const;

export function AlignBadge({ status }: { status: keyof typeof ALIGN_KO }) {
  const [ko, c] = ALIGN_KO[status];
  return <span className="rounded px-1.5 py-0.5 text-xs font-bold text-white" style={{ background: c }} title={status}>{ko}</span>;
}

export function ReviewPanel(p: {
  cmp: Comparison | null;
  changes: Change[];
  page: number;
  selectedId: string | null;
  onSelect: (c: Change) => void;
  onSaved: (c: Change) => void;
  reviewer: string;
  setReviewer: (v: string) => void;
  onCmp: (c: Comparison) => void;
  project: Project | null;
  projects: Project[];
  onProject: (id: string) => void;
  onNewProject: (name: string) => void;
  history: Comparison[];
  onOpen: (id: string) => void;
  onExportJson: () => void;
  alignFailedHidden: boolean;
  onShowFailed: () => void;
  onClose: () => void;
  /** 목록 줄 오른쪽 클릭 → 삭제/복원 메뉴 */
  onRowMenu: (c: Change, clientX: number, clientY: number) => void;
}) {
  const [tab, setTab] = useState<"review" | "history" | "result">("review");
  const [filter, setFilter] = useState<ReviewStatus | "all" | "active" | "dismissed">("active");
  const [hist, setHist] = useState<HistoryItem[] | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const sel = p.changes.find((c) => c.change_id === p.selectedId) ?? null;
  const locked = Boolean(p.cmp?.review_completed_at);
  useEffect(() => setComment(sel?.review.comment ?? ""), [sel?.change_id, sel?.review.comment]);
  useEffect(() => {
    if (!sel) {
      setHist(null);
      return;
    }
    let live = true;
    api.changeHistory(sel.change_id).then((h) => live && setHist(h), () => live && setHist(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.change_id, sel?.review.reviewed_at, sel?.review.dismissed]);

  const pageChanges = p.changes.filter((c) => c.baseline_page === p.page);
  const nDismissed = pageChanges.filter((c) => c.review.dismissed).length;
  const shown =
    filter === "all" ? pageChanges
      : filter === "active" ? pageChanges.filter((c) => !c.review.dismissed)
        : filter === "dismissed" ? pageChanges.filter((c) => c.review.dismissed)
          : pageChanges.filter((c) => c.review.status === filter && !c.review.dismissed);

  async function save(status?: ReviewStatus) {
    if (!sel) return;
    setBusy(true);
    setErr(null);
    try {
      p.onSaved(await api.patchChange(sel.change_id, { status, comment, reviewer: p.reviewer || undefined }));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }
  async function complete() {
    if (!p.cmp) return;
    const done = !p.cmp.review_completed_at;
    const n = p.cmp.review_summary.Unreviewed ?? 0;
    if (done && n > 0 && !window.confirm(`미검토 영역이 ${n}개 남아 있습니다. 현재 상태로 검토 완료하시겠습니까?\n(완료 시점의 판정 집계가 기록됩니다)`)) return;
    try {
      p.onCmp(await api.setReviewCompleted(p.cmp.id, done, p.reviewer || null));
    } catch (e) {
      setErr(errText(e));
    }
  }

  const tabBtn = (k: typeof tab, label: string) => (
    <button type="button" className={`tbtn flex-1 ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{label}</button>
  );

  return (
    <aside className="flex w-[360px] shrink-0 flex-col text-xs" style={{ background: "var(--panel)", borderLeft: "1px solid var(--border)" }}>
      <div className="flex items-center gap-1 p-1.5">
        {tabBtn("review", "검토")}
        {tabBtn("history", "프로젝트·이력")}
        {tabBtn("result", "결과")}
        <button type="button" className="px-1.5" onClick={p.onClose} title="검토 패널 닫기">✕</button>
      </div>
      {err && <div className="px-2" style={{ color: "var(--red)" }}>{err}</div>}

      {tab === "review" && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
          {!p.cmp ? (
            <p style={{ color: "var(--fg2)" }}>비교 결과가 없습니다.</p>
          ) : p.alignFailedHidden ? (
            <div className="space-y-2 p-2" style={{ border: "1px solid var(--red)", color: "var(--red)" }}>
              <p className="font-bold">정렬 실패 – 이 페이지의 차이 {pageChanges.length}개는 실제 도면 변경으로 볼 수 없습니다.</p>
              <p>두 도면이 서로 다른 도면이거나 위치·배율 차이가 커서 자동 정렬이 되지 않았을 수 있습니다.</p>
              <button type="button" className="tbtn" onClick={p.onShowFailed}>그래도 차이 영역 보기</button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1">
                <span className="sec" title="오른쪽 클릭으로 삭제(변경 없음)한 영역은 '삭제됨'에서 볼 수 있습니다">변경 영역 {pageChanges.length - nDismissed}{nDismissed ? ` (삭제 ${nDismissed})` : ""}</span>
                <select className="inp ml-auto" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
                  <option value="active">표시 중 ({pageChanges.length - nDismissed})</option>
                  {REVIEW_STATUSES.map((s) => <option key={s} value={s}>{REVIEW_KO[s].ko} ({pageChanges.filter((c) => c.review.status === s && !c.review.dismissed).length})</option>)}
                  <option value="dismissed">삭제됨 ({nDismissed})</option>
                  <option value="all">전체 ({pageChanges.length})</option>
                </select>
              </div>
              <div className="min-h-[120px] flex-1 overflow-y-auto" style={{ border: "1px solid var(--border)" }}>
                <table className="w-full">
                  <thead className="sticky top-0" style={{ background: "var(--card)", color: "var(--fg2)" }}>
                    <tr><th className="px-1 text-left">No</th><th className="px-1 text-right">OLD만</th><th className="px-1 text-right">NEW만</th><th className="px-1 text-left">판정</th><th className="px-1 text-left">AI</th><th>💬</th></tr>
                  </thead>
                  <tbody>
                    {shown.map((c) => (
                      <tr key={c.change_id} className="cursor-pointer" title="오른쪽 클릭: 삭제 (변경 없음) / 복원"
                        style={{ background: c.change_id === p.selectedId ? "var(--loaded)" : undefined, borderTop: "1px solid var(--border)", opacity: c.review.dismissed ? 0.55 : 1, textDecoration: c.review.dismissed ? "line-through" : undefined }}
                        onClick={() => p.onSelect(c)} onContextMenu={(e) => { e.preventDefault(); p.onRowMenu(c, e.clientX, e.clientY); }}>
                        <td className="px-1 font-bold">{c.detection.region_no}</td>
                        <td className="px-1 text-right">{c.detection.removed_px.toLocaleString()}</td>
                        <td className="px-1 text-right">{c.detection.added_px.toLocaleString()}</td>
                        <td className="px-1" style={{ color: c.review.dismissed ? "var(--fg2)" : REVIEW_KO[c.review.status].color }}>{c.review.dismissed ? "삭제(변경 없음)" : REVIEW_KO[c.review.status].ko}</td>
                        <td className="px-1" title={c.ai?.summary}>{c.ai?.label ?? ""}</td>
                        <td className="text-center">{c.review.comment ? "●" : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {sel && (
                <div className="space-y-1.5">
                  <div className="p-1.5" style={{ border: "1px solid var(--border)" }}>
                    <div className="sec">자동 탐지 (수정 불가)</div>
                    <div>영역 {sel.detection.region_no} · ({sel.detection.bounding_box_px.x0}, {sel.detection.bounding_box_px.y0})–({sel.detection.bounding_box_px.x1}, {sel.detection.bounding_box_px.y1}) px @ {sel.detection.dpi}dpi</div>
                    <div>크기 {pxToMm(sel.detection.bounding_box_px.x1 - sel.detection.bounding_box_px.x0, sel.detection.dpi).toFixed(1)} × {pxToMm(sel.detection.bounding_box_px.y1 - sel.detection.bounding_box_px.y0, sel.detection.dpi).toFixed(1)} mm · OLD만 {sel.detection.removed_px.toLocaleString()} px · NEW만 {sel.detection.added_px.toLocaleString()} px</div>
                  </div>
                  {sel.ai && (
                    <div className="p-1.5" style={{ border: "1px dashed var(--purple)" }}>
                      <div className="sec">AI 제안 (비교 결과를 바꾸지 않음)</div>
                      <div><b>{sel.ai.label}</b> · 설명 : {sel.ai.summary}</div>
                    </div>
                  )}
                  <div className="p-1.5" style={{ border: "1px solid var(--border)" }}>
                    <div className="sec mb-1">사용자 판정 {sel.review.reviewed_at && <span className="font-normal">· {sel.review.reviewer ?? "?"} {new Date(sel.review.reviewed_at).toLocaleString()}</span>}</div>
                    <div className="flex flex-wrap gap-1">
                      {REVIEW_STATUSES.map((s) => (
                        <button key={s} type="button" disabled={busy || locked} className={`tbtn ${sel.review.status === s ? "on" : ""}`} title={`단축키 ${REVIEW_KO[s].key}`} onClick={() => void save(s)}>
                          {REVIEW_KO[s].key}. {REVIEW_KO[s].ko}
                        </button>
                      ))}
                    </div>
                    <textarea className="inp mt-1 h-14 w-full" placeholder="Comment" maxLength={4000} disabled={locked} value={comment} onChange={(e) => setComment(e.target.value)} />
                    <div className="mt-1 flex items-center gap-1">
                      <input className="inp w-28" placeholder="검토자 이름" maxLength={100} value={p.reviewer} onChange={(e) => p.setReviewer(e.target.value)} />
                      <button type="button" className="tbtn on ml-auto" disabled={busy || locked || comment === (sel.review.comment ?? "")} onClick={() => void save()}>Comment 저장</button>
                    </div>
                    {locked && <p style={{ color: "var(--fg2)" }}>검토 완료 상태라 수정할 수 없습니다.</p>}
                  </div>
                    {sel.review.dismissed && (
                      <div className="p-1.5" style={{ border: "1px solid var(--warn)", color: "var(--warn)" }}>
                        사용자 삭제 (변경 없음) · {sel.review.dismissed_by ?? "?"} {sel.review.dismissed_at && new Date(sel.review.dismissed_at).toLocaleString()} – 목록에서 오른쪽 클릭하면 복원할 수 있습니다
                      </div>
                    )}
                    {hist && hist.length > 0 && (
                      <div className="p-1.5" style={{ border: "1px solid var(--border)" }}>
                        <div className="sec mb-0.5">이력</div>
                        {hist.map((h, i) => (
                          <div key={i} style={{ color: h.action === "user_delete" ? "var(--warn)" : "var(--body)" }}>
                            {new Date(h.changed_at).toLocaleString()} · {h.reviewer ?? "?"} · {h.label}{h.action === "user_delete" ? "" : ` → ${REVIEW_KO[h.status].ko}`}
                          </div>
                        ))}
                      </div>
                    )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === "history" && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
          <div className="sec">프로젝트</div>
          <select className="inp" value={p.project?.id ?? ""} onChange={(e) => p.onProject(e.target.value)}>
            {p.projects.map((x) => <option key={x.id} value={x.id}>{x.name} (도면 {x.document_count} · 비교 {x.comparison_count})</option>)}
          </select>
          <div className="flex gap-1">
            <input className="inp flex-1" placeholder="새 프로젝트 이름" maxLength={200} value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button type="button" className="tbtn" disabled={!newName.trim()} onClick={() => { p.onNewProject(newName.trim()); setNewName(""); }}>만들기</button>
          </div>
          <div className="sec mt-2">비교 이력</div>
          {p.history.length === 0 && <p style={{ color: "var(--fg2)" }}>이 프로젝트에 비교가 없습니다.</p>}
          {p.history.map((h) => (
            <button key={h.id} type="button" disabled={h.state !== "succeeded"} onClick={() => p.onOpen(h.id)} className="block w-full p-1.5 text-left disabled:opacity-60"
              style={{ border: `1px solid ${h.id === p.cmp?.id ? "var(--blue)" : "var(--border)"}` }}>
              <div className="truncate font-bold">{h.baseline_document.original_name} → {h.comparison_document.original_name}</div>
              <div style={{ color: "var(--fg2)" }}>
                {new Date(h.created_at).toLocaleString()} · {h.settings.dpi}dpi · {h.settings.tol_mm}mm · {h.state === "failed" ? `실패: ${h.error ?? ""}` : `변경 ${h.pages.reduce((s, x) => s + x.change_count, 0)}`}
                {h.review_completed_at ? " · 검토 완료" : ""}
              </div>
            </button>
          ))}
        </div>
      )}

      {tab === "result" && p.cmp && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
          <div className="flex flex-wrap gap-2">
            {REVIEW_STATUSES.map((s) => <span key={s} style={{ color: REVIEW_KO[s].color }}>{REVIEW_KO[s].ko} {p.cmp!.review_summary[s] ?? 0}</span>)}
          </div>
          <button type="button" className="bigbtn" style={{ background: p.cmp.review_completed_at ? "var(--card)" : "var(--blue)", color: p.cmp.review_completed_at ? "var(--fg)" : "#fff" }} onClick={() => void complete()}>
            {p.cmp.review_completed_at ? "검토 완료 해제" : "검토 완료"}
          </button>
          {p.cmp.review_completed_at && <div style={{ color: "var(--green)" }}>✔ {p.cmp.review_completed_by ?? ""} {new Date(p.cmp.review_completed_at).toLocaleString()}</div>}
          <button type="button" className="tbtn" onClick={p.onExportJson}>결과 JSON 다운로드 (판정·AI 제안·이력 포함)</button>
          <div className="sec mt-2">추적 정보</div>
          <div className="space-y-0.5 break-all font-mono" style={{ color: "var(--fg2)" }}>
            <div>OLD SHA-256 {p.cmp.baseline_document.sha256}</div>
            <div>NEW SHA-256 {p.cmp.comparison_document.sha256}</div>
            <div>엔진 {String(p.cmp.engine?.engine_version ?? "")} · 원본 {String(p.cmp.engine?.source_sha256 ?? "").slice(0, 16)}…</div>
            <div>실행 {p.cmp.started_at && new Date(p.cmp.started_at).toLocaleString()} – {p.cmp.finished_at && new Date(p.cmp.finished_at).toLocaleString()}</div>
            <div>설정 {JSON.stringify(p.cmp.settings)}</div>
            <div>임계값 {JSON.stringify(p.cmp.thresholds)}</div>
          </div>
        </div>
      )}
    </aside>
  );
}
