"use client";

// 기존 CompareCard(비교 돋보기): 도면 위에 떠 있는 OLD/NEW 확대 카드.
// 원본 PDF 에서 같은 위치·같은 배율로 다시 렌더(서버 엔진 render_pt_region / render_old_aligned_region).
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { api, errText, regionUrl } from "@/lib/api";
import { CARD_MAG_MAX, CARD_MAG_MIN, CARD_MAG_STEP, CARD_MIN_H, CARD_MIN_W, cardRegionOrigin, clamp, clampCardPos, clampCardSize } from "@/lib/geometry";
import type { BBox } from "@/lib/types";

export interface CardState {
  page: number;
  cx: number;          // pt
  cy: number;
  mag: number;
  regionNo: number | null;
  layout: "h" | "v";
  pinned: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function CompareCard({
  comparisonId, card, setCard, pageCount, dpi, showBoxes, oldExists, newExists, adopted, hostW, hostH, onClose, onResized, onPaneSize,
}: {
  comparisonId: string;
  card: CardState;
  setCard: (c: CardState) => void;
  pageCount: number;
  dpi: number;
  showBoxes: boolean;
  oldExists: boolean;
  newExists: boolean;
  adopted: boolean;
  hostW: number;
  hostH: number;
  onClose: () => void;
  onResized: (w: number, h: number) => void;
  onPaneSize: (w: number, h: number) => void;
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState<[number, number]>([200, 150]);
  const [shown, setShown] = useState(card);              // 40ms 지연 렌더 (기존 _sched)
  const [boxes, setBoxes] = useState<{ regions: BBox[]; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const drag = useRef<null | { kind: "pane" | "win" | "rs"; mode?: string; x: number; y: number; c: CardState }>(null);

  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const w = Math.max(60, Math.floor(r.width) - 6), h = Math.max(60, Math.floor(r.height) - 6);
      setPane([w, h]);
      onPaneSize(w, h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [onPaneSize, card.layout]);

  useEffect(() => {
    const t = setTimeout(() => setShown(card), 40);
    return () => clearTimeout(t);
  }, [card]);

  const [pw, ph] = pane;
  const [ox, oy] = cardRegionOrigin(shown.cx, shown.cy, shown.mag, pw, ph);
  useEffect(() => {
    if (!showBoxes) {
      setBoxes(null);
      return;
    }
    let live = true;
    api.cardRegions(comparisonId, shown.page, ox, oy, pw, ph, shown.mag).then(
      (r) => live && (setBoxes(r), setErr(null)),
      (e: unknown) => live && setErr(errText(e)),
    );
    return () => {
      live = false;
    };
  }, [comparisonId, shown.page, ox, oy, pw, ph, shown.mag, showBoxes]);

  const k = dpi / 72.0;
  const zoomBy = (f: number) => setCard({ ...card, mag: clamp(card.mag * f, CARD_MAG_MIN, CARD_MAG_MAX) });

  function down(kind: "pane" | "win" | "rs", e: RPointerEvent, mode?: string) {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { kind, mode, x: e.clientX, y: e.clientY, c: card };
  }
  function move(e: RPointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (d.kind === "pane") setCard({ ...card, cx: d.c.cx - dx / card.mag, cy: d.c.cy - dy / card.mag });
    else if (d.kind === "win") {
      const [nx, ny] = clampCardPos(d.c.x + dx, d.c.y + dy, card.w, card.h, hostW, hostH);
      setCard({ ...card, x: nx, y: ny });
    } else {
      const w = d.mode === "e" || d.mode === "se" ? d.c.w + dx : d.c.w;
      const h = d.mode === "s" || d.mode === "se" ? d.c.h + dy : d.c.h;
      const [cw, ch] = clampCardSize(w, h, hostW, hostH, card.x, card.y);
      setCard({ ...card, w: cw, h: ch });
    }
  }
  function up() {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "rs") onResized(card.w, card.h);         // 마지막 크기를 설정 파일에 저장 (기존 set_card_size)
  }

  const pane1 = (which: "old" | "new") => {
    const exists = which === "old" ? oldExists : newExists;
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="sec px-1 text-white" style={{ background: which === "old" ? "var(--old-frame)" : "var(--blue)" }}>{which.toUpperCase()}</div>
        <div
          ref={which === "old" ? paneRef : undefined}
          className="relative min-h-0 flex-1 overflow-hidden bg-white"
          style={{ border: `3px solid ${which === "old" ? "var(--old-frame)" : "var(--blue)"}`, cursor: "move" }}
          onPointerDown={(e) => down("pane", e)}
          onPointerMove={move}
          onPointerUp={up}
          onWheel={(e) => zoomBy(e.deltaY < 0 ? CARD_MAG_STEP : 1 / CARD_MAG_STEP)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt="" draggable={false} className="pointer-events-none absolute left-0 top-0 max-w-none" width={pw} height={ph}
            src={regionUrl(comparisonId, shown.page, which, ox, oy, pw, ph, shown.mag)} style={{ visibility: exists ? "visible" : "hidden" }} />
          {boxes && (
            <svg className="pointer-events-none absolute left-0 top-0" width={pw} height={ph}>
              {boxes.regions.map((r, i) => (
                <rect key={i} x={(r.x0 / k) * shown.mag - ox - 3} y={(r.y0 / k) * shown.mag - oy - 3}
                  width={((r.x1 - r.x0) / k) * shown.mag + 6} height={((r.y1 - r.y0) / k) * shown.mag + 6} fill="none" stroke="var(--hilite)" strokeWidth={2} />
              ))}
            </svg>
          )}
        </div>
      </div>
    );
  };

  const info = !oldExists || !newExists ? "한쪽 문서에 없는 페이지(빈 페이지)" : boxes ? `변경 ${boxes.total}곳${boxes.total > 300 ? " (300곳까지 표시)" : ""}` : adopted ? "정렬 반영" : "정렬 없음";
  return (
    <div
      className="absolute z-20 flex flex-col"
      style={{ left: card.x, top: card.y, width: card.w, height: card.h, minWidth: CARD_MIN_W, minHeight: CARD_MIN_H, background: "var(--panel)", border: "2px solid var(--blue)" }}
      onPointerMove={move}
      onPointerUp={up}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 px-2 py-0.5" style={{ background: "var(--border)", cursor: "move" }} onPointerDown={(e) => down("win", e)}>
        <span className="sec flex-1 truncate">비교 돋보기 · Page {card.page + 1} / {pageCount}{card.regionNo ? ` · 변경 #${card.regionNo}` : ""}</span>
        {(["h", "v"] as const).map((l) => (
          <label key={l} className="flex items-center gap-0.5 text-xs" onPointerDown={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={card.layout === l} onChange={() => setCard({ ...card, layout: l })} />{l === "h" ? "가로" : "세로"}
          </label>
        ))}
        <label className="flex items-center gap-0.5 text-xs" onPointerDown={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={card.pinned} onChange={(e) => setCard({ ...card, pinned: e.target.checked })} />고정
        </label>
        <button type="button" className="px-1" onPointerDown={(e) => e.stopPropagation()} onClick={onClose} title="닫기">✕</button>
      </div>
      <div className={`flex min-h-0 flex-1 gap-1.5 p-1 ${card.layout === "v" ? "flex-col" : "flex-row"}`}>
        {pane1("old")}
        {pane1("new")}
      </div>
      <div className="flex items-center gap-1 px-1.5 pb-1.5 text-xs">
        <button type="button" className="tbtn" onClick={() => zoomBy(1 / CARD_MAG_STEP)}>−</button>
        <span className="w-14 text-center">{(card.mag * 100).toFixed(0)}%</span>
        <button type="button" className="tbtn" onClick={() => zoomBy(CARD_MAG_STEP)}>+</button>
        <span className="ml-3" style={{ color: "var(--body)" }}>{info}</span>
        {err && <span style={{ color: "var(--red)" }}>{err}</span>}
      </div>
      {(["e", "s", "se"] as const).map((m) => (
        <div key={m} onPointerDown={(e) => down("rs", e, m)} title="끌어서 비교 돋보기 창 크기를 조정합니다"
          className="absolute"
          style={m === "e" ? { right: 0, top: 28, width: 6, bottom: 18, cursor: "ew-resize" } : m === "s" ? { left: 0, bottom: 0, height: 6, right: 18, cursor: "ns-resize" } : { right: 0, bottom: 0, width: 18, height: 18, cursor: "nwse-resize", color: "var(--fg2)", fontSize: 11, textAlign: "right" }}>
          {m === "se" ? "◢" : ""}
        </div>
      ))}
    </div>
  );
}

export const cardRegionPx = (c: CardState, dpi: number, pw: number, ph: number): [number, number, number, number] => {
  const k = dpi / 72.0;
  const hw = (pw / c.mag / 2) * k, hh = (ph / c.mag / 2) * k;
  return [c.cx * k - hw, c.cy * k - hh, c.cx * k + hw, c.cy * k + hh];
};
