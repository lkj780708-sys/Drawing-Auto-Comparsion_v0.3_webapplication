"use client";

// 기존 ViewerCanvas 를 옮긴 도면 뷰어: 표시·확대·이동 + 마크업 상호작용 + 변경 알림(숫자 버블 / 박스).
// 좌표: 이미지 px (= New 페이지를 dpi 로 렌더한 좌표), 마크업은 New 페이지 pt. 비교 연산은 하지 않는다.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as RKeyboardEvent, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import {
  BUBBLE_RADIUS_PX, DIFF_BOX_MAX_DRAW, DIFF_BOX_PAD_PX, HANDLE_SIZE_PX, PICK_TOLERANCE_PX, TEXT_TOOLS, ZOOM_MAX, ZOOM_MIN,
  calloutLeader, clamp, cloudOutline, dragHandle, fitView, handlesOf, hitHandle, hitMarkup, markupBBox, normRect, ptsToSvg,
  zoomAt, zoomToRect, type View,
} from "@/lib/geometry";
import type { Bubble, Change, Markup, MarkupKind, MarkupStyle, Pt } from "@/lib/types";

export interface ViewerProps {
  role: "main" | "side_old" | "side_new";
  label?: ReactNode;
  src: string | null;
  emptyText?: string;
  imgW: number;
  imgH: number;
  dpi: number;
  view: View | null;
  onView: (v: View) => void;
  onSize?: (w: number, h: number) => void;
  fitSignal: number;
  changes: Change[];
  showBoxes: boolean;
  selectedNo: number | null;
  bubbles: Bubble[] | null;
  onBubble: (regionNo: number) => void;
  markups: Markup[] | null;          // null = 이 화면에는 마크업을 표시하지 않음
  editable: boolean;
  denyReason: string;
  tool: MarkupKind | null;
  setTool: (t: MarkupKind | null) => void;
  toolStyle: (k: MarkupKind) => MarkupStyle;
  sel: number;
  setSel: (i: number) => void;
  onMarkups: (ms: Markup[], sel: number) => void;
  boxZoom: boolean;
  magnifier: boolean;
  onMagClick: (ix: number, iy: number) => void;
  cardRect: [number, number, number, number] | null;
  onNotice: (msg: string) => void;
  onCursor?: (p: Pt | null) => void;
  onActivate?: () => void;
  /** 버블·변경 박스 오른쪽 클릭 (clientX, clientY = 메뉴 위치) */
  onRegionMenu?: (regionNo: number, clientX: number, clientY: number) => void;
}

type Drag =
  | { mode: "pan"; sx: number; sy: number; v: View; moved: boolean; mag: boolean; empty: boolean }
  | { mode: "box"; sx: number; sy: number; x: number; y: number }
  | { mode: "create"; m: Markup }
  | { mode: "move"; index: number; start: Pt; snap: Pt[]; moved: boolean }
  | { mode: "handle"; index: number; handle: string; snap: Pt[] };

interface Editing { index: number; isNew: boolean; text: string }

export function Viewer(p: ViewerProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<[number, number]>([0, 0]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [poly, setPoly] = useState<Pt[]>([]);
  const [tip, setTip] = useState<Pt | null>(null);
  const [hover, setHover] = useState<Pt | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const viewRef = useRef(p.view);
  viewRef.current = p.view;
  const { onView, onSize, imgW, imgH } = p;
  const k = p.dpi / 72.0;
  const v = p.view;
  const sc = v ? v.zoom * k : 1;                                  // 화면 px / pt
  const tol = PICK_TOLERANCE_PX / Math.max(sc, 1e-6);
  const ms = p.markups ?? [];

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize([r.width, r.height]);
      onSize?.(r.width, r.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [onSize]);

  // 처음 표시하거나 페이지 크기가 바뀌면, 또는 Fit 요청 시 화면 맞춤 (기존 redraw/_fitted_key 와 같음)
  const fittedKey = useRef<string>("");
  useEffect(() => {
    if (size[0] < 10 || !p.src) return;
    const key = `${imgW}x${imgH}`;
    if (viewRef.current === null || key !== fittedKey.current) {
      fittedKey.current = key;
      onView(fitView(imgW, imgH, size[0], size[1]));
    }
  }, [size, imgW, imgH, p.src, onView]);
  useEffect(() => {
    if (p.fitSignal > 0 && size[0] > 10) onView(fitView(imgW, imgH, size[0], size[1]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.fitSignal]);

  // 휠: 기존과 같이 휠 = 세로 이동, Ctrl+휠 = 확대 (passive 해제 필요)
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const cur = viewRef.current;
      if (!cur) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const steps = -e.deltaY / 120;
      if (e.ctrlKey) onView(zoomAt(cur, e.clientX - r.left, e.clientY - r.top, Math.pow(1.15, steps)));
      else onView({ ...cur, oy: cur.oy - (steps * 60) / cur.zoom });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onView]);

  // 페이지·화면 전환 시 진행 중인 작성 취소 (기존 cancel_all)
  useEffect(() => {
    setPoly([]);
    setTip(null);
    setDrag(null);
    setEditing(null);
  }, [p.tool, imgW, imgH]);

  const i2s = (ix: number, iy: number): Pt => (v ? [(ix - v.ox) * v.zoom, (iy - v.oy) * v.zoom] : [0, 0]);
  const s2i = (sx: number, sy: number): Pt => (v ? [v.ox + sx / v.zoom, v.oy + sy / v.zoom] : [0, 0]);
  const pt2s = (q: Pt | number[]): Pt => i2s(q[0] * k, q[1] * k);
  const s2pt = (sx: number, sy: number): Pt => {
    const [ix, iy] = s2i(sx, sy);
    return [ix / k, iy / k];
  };
  const local = (e: RPointerEvent | MouseEvent | { clientX: number; clientY: number }): Pt => {
    const r = boxRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const commit = useCallback((next: Markup[], sel: number) => p.onMarkups(next, sel), [p]);

  function finishCreate(m: Markup) {
    const minsz = Math.max(1.0, tol * 0.8);
    let ok: boolean;
    if (m.kind === "line" || m.kind === "arrow") ok = Math.hypot(m.pts[1][0] - m.pts[0][0], m.pts[1][1] - m.pts[0][1]) >= minsz;
    else {
      const [x0, y0, x1, y1] = normRect(m.pts[0], m.pts[1]);
      ok = x1 - x0 >= minsz && y1 - y0 >= minsz;
      if (ok) m = { ...m, pts: [[x0, y0], [x1, y1], ...m.pts.slice(2)] };
    }
    if (!ok) return;
    const next = [...ms, m];
    setTip(null);
    if (TEXT_TOOLS.includes(m.kind)) {
      commit(next, next.length - 1);
      setEditing({ index: next.length - 1, isNew: true, text: "" });
    } else {
      commit(next, next.length - 1);
      p.setTool(null);                                     // AUTO_RETURN_TO_SELECT
    }
  }

  function finishPolygon(points: Pt[]) {
    const pts: Pt[] = [];
    for (const q of points) if (!pts.length || Math.hypot(q[0] - pts[pts.length - 1][0], q[1] - pts[pts.length - 1][1]) > 1e-6) pts.push(q);
    setPoly([]);
    setHover(null);
    if (pts.length < 3) return false;
    const next = [...ms, { kind: "polygon" as const, pts, text: "", style: { ...p.toolStyle("polygon") } }];
    commit(next, next.length - 1);
    p.setTool(null);
    return true;
  }

  function hitBubble(sx: number, sy: number): number | null {
    if (!p.bubbles || !v) return null;
    for (let i = p.bubbles.length - 1; i >= 0; i--) {
      const [cx, cy] = i2s(p.bubbles[i].cx, p.bubbles[i].cy);
      if ((sx - cx) ** 2 + (sy - cy) ** 2 <= (BUBBLE_RADIUS_PX + 2) ** 2) return p.bubbles[i].region_no;
    }
    return null;
  }

  /** 화면 좌표의 변경 박스 (보이는 박스만, 가장 작은 것 우선) */
  function hitBox(sx: number, sy: number): number | null {
    if (!v || !(p.showBoxes || p.selectedNo !== null)) return null;
    const pad = DIFF_BOX_PAD_PX + 2;
    let best: number | null = null;
    let area = Infinity;
    for (const c of p.changes) {
      if (!p.showBoxes && c.detection.region_no !== p.selectedNo) continue;
      const bb = c.detection.bounding_box_px;
      const [x0, y0] = i2s(bb.x0, bb.y0), [x1, y1] = i2s(bb.x1, bb.y1);
      if (sx >= x0 - pad && sx <= x1 + pad && sy >= y0 - pad && sy <= y1 + pad && (x1 - x0) * (y1 - y0) < area) {
        best = c.detection.region_no;
        area = (x1 - x0) * (y1 - y0);
      }
    }
    return best;
  }

  function onContextMenu(e: RMouseEvent<HTMLDivElement>) {
    e.preventDefault();
    if (!p.onRegionMenu || !v || p.tool || poly.length || tip) return;
    const [sx, sy] = local(e);
    const reg = hitBubble(sx, sy) ?? hitBox(sx, sy);
    if (reg !== null) p.onRegionMenu(reg, e.clientX, e.clientY);
  }

  function onPointerDown(e: RPointerEvent<HTMLDivElement>) {
    if (!v || !p.src || e.button !== 0) return;
    boxRef.current?.focus();
    p.onActivate?.();
    if (editing) commitEdit();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const [sx, sy] = local(e);
    if (p.boxZoom) {
      setDrag({ mode: "box", sx, sy, x: sx, y: sy });
      return;
    }
    if (!p.tool) {
      const reg = hitBubble(sx, sy);
      if (reg !== null) {
        p.onBubble(reg);
        return;
      }
    }
    if (p.magnifier) {
      setDrag({ mode: "pan", sx, sy, v, moved: false, mag: true, empty: false });
      return;
    }
    if (p.markups && p.editable) {
      const [x, y] = s2pt(sx, sy);
      const t = p.tool;
      if (t === "polygon") {
        setPoly([...poly, [x, y]]);
        setHover([x, y]);
        return;
      }
      if (t === "callout" && tip === null) {
        setTip([x, y]);
        setHover([x, y]);
        return;
      }
      if (t) {
        const pts: Pt[] = [[x, y], [x, y]];
        if (t === "callout" && tip) pts.push(tip);
        setDrag({ mode: "create", m: { kind: t, pts, text: "", style: { ...p.toolStyle(t) } } });
        return;
      }
      if (p.sel >= 0 && ms[p.sel]) {
        const h = hitHandle(ms[p.sel], x, y, tol);
        if (h) {
          setDrag({ mode: "handle", index: p.sel, handle: h, snap: ms[p.sel].pts.map((q) => [q[0], q[1]] as Pt) });
          return;
        }
      }
      for (let i = ms.length - 1; i >= 0; i--) {
        if (hitMarkup(ms[i], x, y, tol)) {
          p.setSel(i);
          setDrag({ mode: "move", index: i, start: [x, y], snap: ms[i].pts.map((q) => [q[0], q[1]] as Pt), moved: false });
          return;
        }
      }
    } else if (p.tool) {
      p.onNotice(p.denyReason);
    }
    setDrag({ mode: "pan", sx, sy, v, moved: false, mag: false, empty: true });
  }

  function onPointerMove(e: RPointerEvent<HTMLDivElement>) {
    if (!v) return;
    const [sx, sy] = local(e);
    const [ix, iy] = s2i(sx, sy);
    p.onCursor?.(ix >= 0 && iy >= 0 && ix <= imgW && iy <= imgH ? [ix, iy] : null);
    const ptp = s2pt(sx, sy);
    if (p.markups && p.editable && (poly.length || tip)) setHover(ptp);
    const d = drag;
    if (!d) return;
    if (d.mode === "box") setDrag({ ...d, x: sx, y: sy });
    else if (d.mode === "pan") {
      const moved = d.moved || Math.abs(sx - d.sx) + Math.abs(sy - d.sy) > 3;
      if (moved !== d.moved) setDrag({ ...d, moved });
      onView({ ...d.v, ox: d.v.ox - (sx - d.sx) / d.v.zoom, oy: d.v.oy - (sy - d.sy) / d.v.zoom });
    } else if (d.mode === "create") setDrag({ mode: "create", m: { ...d.m, pts: [d.m.pts[0], ptp, ...d.m.pts.slice(2)] } });
    else if (d.mode === "move") {
      const dx = ptp[0] - d.start[0], dy = ptp[1] - d.start[1];
      if (Math.hypot(dx, dy) > tol * 0.5 || d.moved) {
        if (!d.moved) setDrag({ ...d, moved: true });
        commit(ms.map((m, i) => (i === d.index ? { ...m, pts: d.snap.map((q) => [q[0] + dx, q[1] + dy] as Pt) } : m)), d.index);
      }
    } else if (d.mode === "handle") {
      commit(ms.map((m, i) => (i === d.index ? { ...m, pts: dragHandle(d.snap, d.handle, ptp[0], ptp[1], Math.max(2.0, tol * 0.5)) } : m)), d.index);
    }
  }

  function onPointerUp(e: RPointerEvent<HTMLDivElement>) {
    const d = drag;
    setDrag(null);
    if (!d || !v) return;
    const [sx, sy] = local(e);
    if (d.mode === "box") {
      if (Math.abs(sx - d.sx) > 8 && Math.abs(sy - d.sy) > 8) onView(zoomToRect(v, d.sx, d.sy, sx, sy, size[0], size[1]));
    } else if (d.mode === "create") finishCreate(d.m);
    else if (d.mode === "pan") {
      if (d.mag && !d.moved) {
        const [ix, iy] = s2i(sx, sy);
        p.onMagClick(ix, iy);
      } else if (d.empty && !d.moved && p.sel >= 0) p.setSel(-1);
    }
  }

  function onDoubleClick(e: RMouseEvent<HTMLDivElement>) {
    if (!p.markups || !p.editable || p.boxZoom) return;
    if (p.tool === "polygon") {
      finishPolygon(poly);
      return;
    }
    if (p.tool) return;
    const [x, y] = s2pt(...local(e));
    for (let i = ms.length - 1; i >= 0; i--) {
      if (hitMarkup(ms[i], x, y, tol) && TEXT_TOOLS.includes(ms[i].kind)) {
        p.setSel(i);
        setEditing({ index: i, isNew: false, text: ms[i].text });
        return;
      }
    }
  }

  function onKeyDown(e: RKeyboardEvent<HTMLDivElement>) {
    if (e.target !== boxRef.current) return;
    if (e.key === "Escape") {
      if (poly.length || tip || drag) {
        setPoly([]);
        setTip(null);
        setDrag(null);
      } else if (p.sel >= 0) p.setSel(-1);
      else if (p.tool) p.setTool(null);
      return;
    }
    if (!p.markups || !p.editable) return;
    if (e.key === "Enter" && p.tool === "polygon" && poly.length) finishPolygon(poly);
    else if (e.key === "Backspace" && p.tool === "polygon" && poly.length) setPoly(poly.slice(0, -1));
    else if (e.key === "Delete" && p.sel >= 0 && !p.tool) commit(ms.filter((_, i) => i !== p.sel), -1);
  }

  function commitEdit(text?: string) {
    if (!editing) return;
    const t = text ?? editing.text;
    const idx = editing.index;
    setEditing(null);
    if (ms[idx] && ms[idx].text !== t) commit(ms.map((m, i) => (i === idx ? { ...m, text: t } : m)), idx);
    if (editing.isNew) p.setTool(null);
  }
  function cancelEdit() {
    if (!editing) return;
    const ed = editing;
    setEditing(null);
    if (ed.isNew) commit(ms.filter((_, i) => i !== ed.index), -1);
    boxRef.current?.focus();
  }

  // ------------------------------------------------------------------ 그리기 (화면 좌표 SVG)
  function shape(m: Markup, key: string, preview = false): ReactNode {
    const st = m.style;
    const w = Math.max(1.0, st.width * sc);
    const fill = st.fill && m.kind !== "line" && m.kind !== "arrow" ? st.fill : "none";
    const dash = preview ? "5 3" : undefined;
    const common = { stroke: st.stroke, strokeWidth: w, strokeDasharray: dash, fill };
    if (m.kind === "line" || m.kind === "arrow") {
      const [a, b] = [pt2s(m.pts[0]), pt2s(m.pts[1])];
      const ah = Math.max(8, w * 4);
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      return (
        <g key={key}>
          <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} {...common} />
          {m.kind === "arrow" && (
            <polygon
              fill={st.stroke}
              points={ptsToSvg([b, [b[0] - ah * Math.cos(ang) + (ah / 2.5) * Math.sin(ang), b[1] - ah * Math.sin(ang) - (ah / 2.5) * Math.cos(ang)],
                [b[0] - ah * Math.cos(ang) - (ah / 2.5) * Math.sin(ang), b[1] - ah * Math.sin(ang) + (ah / 2.5) * Math.cos(ang)]])}
            />
          )}
        </g>
      );
    }
    if (m.kind === "polygon") return <polygon key={key} points={ptsToSvg(m.pts.map(pt2s))} {...common} />;
    const [x0, y0, x1, y1] = normRect(m.pts[0], m.pts[1]);
    const a = pt2s([x0, y0]), b = pt2s([x1, y1]);
    if (m.kind === "ellipse") return <ellipse key={key} cx={(a[0] + b[0]) / 2} cy={(a[1] + b[1]) / 2} rx={Math.abs(b[0] - a[0]) / 2} ry={Math.abs(b[1] - a[1]) / 2} {...common} />;
    if (m.kind === "cloud") return <polygon key={key} points={ptsToSvg(cloudOutline(x0, y0, x1, y1).map(pt2s))} {...common} />;
    if (m.kind === "rect") return <rect key={key} x={a[0]} y={a[1]} width={b[0] - a[0]} height={b[1] - a[1]} {...common} />;
    // textbox / callout
    let leader: ReactNode = null;
    if (m.kind === "callout" && m.pts.length > 2) {
      const [t, en] = calloutLeader(m);
      const ts = pt2s(t), es = pt2s(en);
      const ang = Math.atan2(ts[1] - es[1], ts[0] - es[0]);
      leader = (
        <g>
          <line x1={es[0]} y1={es[1]} x2={ts[0]} y2={ts[1]} stroke={st.stroke} strokeWidth={w} strokeDasharray={dash} />
          <polygon fill={st.stroke} points={ptsToSvg([ts, [ts[0] - 10 * Math.cos(ang) + 4 * Math.sin(ang), ts[1] - 10 * Math.sin(ang) - 4 * Math.cos(ang)],
            [ts[0] - 10 * Math.cos(ang) - 4 * Math.sin(ang), ts[1] - 10 * Math.sin(ang) + 4 * Math.cos(ang)]])} />
        </g>
      );
    }
    const isEditing = editing !== null && ms[editing.index] === m;
    return (
      <g key={key}>
        {leader}
        <rect x={a[0]} y={a[1]} width={b[0] - a[0]} height={b[1] - a[1]} {...common} />
        {m.text && !isEditing && (
          <foreignObject x={a[0] + 2} y={a[1] + 2} width={Math.max(10, b[0] - a[0] - 4)} height={Math.max(10, b[1] - a[1] - 4)}>
            <div style={{ fontFamily: st.font, fontSize: Math.max(1, st.font_size * sc), color: st.text_color, lineHeight: 1.15, whiteSpace: "pre-wrap", wordBreak: "break-word", overflow: "hidden", height: "100%" }}>
              {m.text}
            </div>
          </foreignObject>
        )}
      </g>
    );
  }

  const cursor = p.boxZoom || p.magnifier || p.tool ? "crosshair" : drag?.mode === "pan" ? "grabbing" : "default";
  const boxes: ReactNode[] = [];
  if (v && (p.showBoxes || p.selectedNo !== null)) {
    let n = 0;
    for (const c of p.changes) {
      const sel = c.detection.region_no === p.selectedNo;
      if (!p.showBoxes && !sel) continue;
      const bb = c.detection.bounding_box_px;
      const [x0, y0] = i2s(bb.x0, bb.y0), [x1, y1] = i2s(bb.x1, bb.y1);
      if (x1 < -8 || y1 < -8 || x0 > size[0] + 8 || y0 > size[1] + 8) continue;
      const pad = DIFF_BOX_PAD_PX;
      boxes.push(<rect key={c.change_id} x={x0 - pad} y={y0 - pad} width={x1 - x0 + 2 * pad} height={y1 - y0 + 2 * pad} fill="none" stroke={sel ? "var(--blue)" : "var(--hilite)"} strokeWidth={sel ? 3 : 2} />);
      if (++n >= DIFF_BOX_MAX_DRAW) break;
    }
  }
  const selM = p.markups && p.editable && p.sel >= 0 ? ms[p.sel] : undefined;
  const edM = editing ? ms[editing.index] : undefined;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {p.label}
      <div
        ref={boxRef}
        tabIndex={0}
        className="relative min-h-0 flex-1 overflow-hidden outline-none select-none"
        style={{ background: "var(--viewbg)", cursor, touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => p.onCursor?.(null)}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
      >
        {!p.src ? (
          <div className="flex h-full items-center justify-center" style={{ color: "var(--fg2)" }}>{p.emptyText ?? ""}</div>
        ) : (
          v && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={p.src}
                alt=""
                draggable={false}
                className="pointer-events-none absolute max-w-none"
                style={{ left: -v.ox * v.zoom, top: -v.oy * v.zoom, width: imgW * v.zoom, height: imgH * v.zoom, imageRendering: v.zoom >= 4 ? "pixelated" : "auto", background: "#fff" }}
              />
              <svg className="pointer-events-none absolute left-0 top-0" width={size[0]} height={size[1]}>
                {boxes}
                {ms.map((m, i) => shape(m, `m${i}`))}
                {drag?.mode === "create" && shape(drag.m, "creating", true)}
                {poly.length > 0 && (
                  <g>
                    <polyline points={ptsToSvg([...poly, ...(hover ? [hover] : [])].map(pt2s))} fill="none" stroke={p.toolStyle("polygon").stroke} strokeDasharray="4 3" strokeWidth={Math.max(1, p.toolStyle("polygon").width * sc)} />
                    {poly.map((q, i) => {
                      const s = pt2s(q);
                      return <circle key={i} cx={s[0]} cy={s[1]} r={3} fill="#fff" stroke="var(--blue)" />;
                    })}
                  </g>
                )}
                {tip && (
                  <g>
                    <circle cx={pt2s(tip)[0]} cy={pt2s(tip)[1]} r={4} fill="none" stroke="var(--blue)" strokeWidth={2} />
                    {hover && <line x1={pt2s(tip)[0]} y1={pt2s(tip)[1]} x2={pt2s(hover)[0]} y2={pt2s(hover)[1]} stroke="var(--blue)" strokeDasharray="4 3" />}
                  </g>
                )}
                {selM && (() => {
                  const [x0, y0, x1, y1] = markupBBox(selM);
                  const a = pt2s([x0, y0]), b = pt2s([x1, y1]);
                  const hs = HANDLE_SIZE_PX / 2;
                  return (
                    <g>
                      <rect x={a[0] - 3} y={a[1] - 3} width={b[0] - a[0] + 6} height={b[1] - a[1] + 6} fill="none" stroke="var(--blue)" strokeDasharray="3 3" />
                      {Object.entries(handlesOf(selM)).map(([n, q]) => {
                        const s = pt2s(q);
                        return <rect key={n} x={s[0] - hs} y={s[1] - hs} width={hs * 2} height={hs * 2} fill="#fff" stroke="var(--blue)" strokeWidth={1.5} />;
                      })}
                    </g>
                  );
                })()}
                {p.bubbles && p.bubbles.map((bu) => {
                  const c = p.changes.find((x) => x.detection.region_no === bu.region_no);
                  if (!c) return null;
                  const R = BUBBLE_RADIUS_PX;
                  const [cx, cy] = i2s(bu.cx, bu.cy);
                  if (cx < -R || cy < -R || cx > size[0] + R || cy > size[1] + R) return null;
                  const bb = c.detection.bounding_box_px;
                  const [bx0, by0] = i2s(bb.x0, bb.y0), [bx1, by1] = i2s(bb.x1, bb.y1);
                  const tx = clamp(cx, bx0 - 2, bx1 + 2), ty = clamp(cy, by0 - 2, by1 + 2);
                  return (
                    <g key={`b${bu.region_no}`}>
                      <line x1={cx} y1={cy} x2={tx} y2={ty} stroke="var(--bubble-edge)" strokeWidth={1.5} />
                      <circle cx={cx} cy={cy} r={R} fill="var(--bubble)" stroke={bu.region_no === p.selectedNo ? "var(--blue)" : "var(--bubble-edge)"} strokeWidth={2} />
                      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontFamily="Arial" fontWeight={700} fontSize={bu.region_no < 100 ? 12 : 9} fill="#000">{bu.region_no}</text>
                    </g>
                  );
                })}
                {p.cardRect && (() => {
                  const a = i2s(p.cardRect[0], p.cardRect[1]), b = i2s(p.cardRect[2], p.cardRect[3]);
                  return <rect x={a[0]} y={a[1]} width={b[0] - a[0]} height={b[1] - a[1]} fill="none" stroke="var(--card-region)" strokeWidth={1} />;
                })()}
                {drag?.mode === "box" && <rect x={Math.min(drag.sx, drag.x)} y={Math.min(drag.sy, drag.y)} width={Math.abs(drag.x - drag.sx)} height={Math.abs(drag.y - drag.sy)} fill="none" stroke="var(--blue)" strokeDasharray="4 3" />}
              </svg>
              {edM && editing && (() => {
                const [x0, y0, x1, y1] = normRect(edM.pts[0], edM.pts[1]);
                const a = pt2s([x0, y0]), b = pt2s([x1, y1]);
                return (
                  <textarea
                    autoFocus
                    className="absolute resize-none p-0.5"
                    style={{ left: a[0], top: a[1], width: Math.max(60, b[0] - a[0]), height: Math.max(30, b[1] - a[1]), fontFamily: edM.style.font, fontSize: Math.max(8, edM.style.font_size * sc), color: edM.style.text_color, background: edM.style.fill ?? "#fff", border: "1px solid var(--blue)", lineHeight: 1.15 }}
                    value={editing.text}
                    onChange={(ev) => setEditing({ ...editing, text: ev.target.value })}
                    onPointerDown={(ev) => ev.stopPropagation()}
                    onKeyDown={(ev) => {
                      ev.stopPropagation();
                      if (ev.key === "Escape") cancelEdit();
                      else if (ev.key === "Enter" && ev.ctrlKey) commitEdit();
                    }}
                    onBlur={() => commitEdit()}
                  />
                );
              })()}
            </>
          )
        )}
      </div>
    </div>
  );
}

export { ZOOM_MAX, ZOOM_MIN };
