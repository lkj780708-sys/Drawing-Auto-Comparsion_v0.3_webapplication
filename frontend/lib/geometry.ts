// 화면 표시·마우스 상호작용용 기하 함수 – 엔진 3부(마크업 모델)와 2부 카드 배치 함수를 그대로 옮긴 것.
// 비교·판정 로직은 없음. 수치가 엔진과 같은지 verification/geom_parity.js 로 검사한다.
import type { Markup, MarkupKind, Pt } from "./types";

// ---------------------------------------------------------------- 엔진 상수 (1부, 코드 확인값)
export const PICK_TOLERANCE_PX = 6;
export const HANDLE_SIZE_PX = 7;
export const MIN_MARKUP_DRAG_PX = 5;
export const FILL_SUGGEST = "#98FB98";
export const WIDTH_RANGE: [number, number] = [0.1, 20.0];
export const FONT_SIZE_RANGE: [number, number] = [4.0, 144.0];
export const FONT_CHOICES = ["Arial", "Times New Roman", "Courier New"] as const;
export const TEXT_TOOLS: readonly MarkupKind[] = ["textbox", "callout"];
export const FILL_TOOLS: readonly MarkupKind[] = ["textbox", "callout", "rect", "ellipse", "polygon", "cloud"];
export const RECT_KINDS: readonly MarkupKind[] = ["textbox", "callout", "rect", "ellipse", "cloud"];
export const BUBBLE_RADIUS_PX = 11;
export const BUBBLE_MAX_DISPLAY = 500;
export const DIFF_BOX_PAD_PX = 4;
export const DIFF_BOX_MAX_DRAW = 1500;
export const CARD_DEFAULT_SIZE: [number, number] = [640, 360];
export const CARD_MIN_W = 420;
export const CARD_MIN_H = 260;
export const CARD_MAG_DEFAULT = 4.0;
export const CARD_MAG_MIN = 1.0;
export const CARD_MAG_MAX = 60.0;
export const CARD_MAG_STEP = 1.25;
export const CARD_CONTEXT_MM = 8.0;
export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 40.0;
export const TOOL_LABEL: Record<MarkupKind, string> = {
  textbox: "텍스트 상자", callout: "설명선", line: "선", arrow: "화살표",
  rect: "사각형", ellipse: "타원형", polygon: "다각형", cloud: "구름",
};
export const TOOL_HINT: Record<MarkupKind, string> = {
  textbox: "텍스트 상자: 드래그로 영역 지정 → 바로 글자 입력",
  callout: "설명선: ① 지시 대상 클릭 → ② 텍스트 영역 드래그 → ③ 바로 글자 입력",
  line: "선: 시작점에서 끝점까지 드래그",
  arrow: "화살표: 시작점에서 끝점까지 드래그 (끝점에 화살촉)",
  rect: "사각형: 드래그로 영역 지정",
  ellipse: "타원형: 드래그로 영역 지정",
  polygon: "다각형: 클릭으로 꼭짓점 추가 / 더블클릭·Enter 완료 / Backspace 점 삭제 / Esc 취소",
  cloud: "구름: 드래그로 사각 영역 지정",
};
export const POLICY_REASON = {
  old: "Old 화면에서는 마크업을 작성·편집할 수 없습니다 (New 화면에서만 가능)",
  side_old: "나란히 보기의 Old 영역에서는 마크업을 작성·편집할 수 없습니다",
  blank: "실제 New 페이지가 없는 비교용 빈 페이지에는 마크업을 작성할 수 없습니다",
  nocompare: "PDF 비교를 먼저 실행하세요",
} as const;

// ---------------------------------------------------------------- 보기 (기존 ViewerCanvas 좌표계: screen = (img - o) * zoom)
export interface View { zoom: number; ox: number; oy: number }
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** Python round() 과 같은 반올림 (0.5 는 짝수 쪽) – 엔진과 수치를 맞추기 위함 */
export function pyRound(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export function fitView(W: number, H: number, cw: number, ch: number): View {
  cw = Math.max(cw, 50);
  ch = Math.max(ch, 50);
  const zoom = clamp(Math.min(cw / W, ch / H) * 0.98, ZOOM_MIN, ZOOM_MAX);
  return { zoom, ox: -(cw / zoom - W) / 2, oy: -(ch / zoom - H) / 2 };
}
export function zoomAt(v: View, sx: number, sy: number, factor: number): View {
  const nz = clamp(v.zoom * factor, ZOOM_MIN, ZOOM_MAX);
  const ix = v.ox + sx / v.zoom;
  const iy = v.oy + sy / v.zoom;
  return { zoom: nz, ox: ix - sx / nz, oy: iy - sy / nz };
}
export function zoomToRect(v: View, sx0: number, sy0: number, sx1: number, sy1: number, cw: number, ch: number): View {
  const x0 = v.ox + Math.min(sx0, sx1) / v.zoom;
  const y0 = v.oy + Math.min(sy0, sy1) / v.zoom;
  const x1 = v.ox + Math.max(sx0, sx1) / v.zoom;
  const y1 = v.oy + Math.max(sy0, sy1) / v.zoom;
  const w = Math.max(x1 - x0, 1);
  const h = Math.max(y1 - y0, 1);
  const nz = clamp(Math.min(cw / w, ch / h), ZOOM_MIN, ZOOM_MAX);
  return { zoom: nz, ox: (x0 + x1) / 2 - cw / nz / 2, oy: (y0 + y1) / 2 - ch / nz / 2 };
}
export function centerOn(v: View, ix: number, iy: number, cw: number, ch: number): View {
  return { zoom: v.zoom, ox: ix - cw / v.zoom / 2, oy: iy - ch / v.zoom / 2 };
}

// ---------------------------------------------------------------- 마크업 형상 (엔진 3부 그대로)
export function normRect(p0: Pt | number[], p1: Pt | number[]): [number, number, number, number] {
  return [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])];
}
export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  if (L2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
export function polylineDist(x: number, y: number, pts: Pt[], closed = true): number {
  let best = Infinity;
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    best = Math.min(best, segDist(x, y, a[0], a[1], b[0], b[1]));
  }
  return best;
}
export function pointInPoly(x: number, y: number, pts: Pt[]): boolean {
  let inside = false;
  const n = pts.length;
  let j = n - 1;
  for (let i = 0; i < n; i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
    j = i;
  }
  return inside;
}
export function ellipsePoly(x0: number, y0: number, x1: number, y1: number, n = 48): Pt[] {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, a = (x1 - x0) / 2, b = (y1 - y0) / 2;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) out.push([cx + a * Math.cos((2 * Math.PI * i) / n), cy + b * Math.sin((2 * Math.PI * i) / n)]);
  return out;
}
export function cloudOutline(x0: number, y0: number, x1: number, y1: number, arc?: number): Pt[] {
  const w = x1 - x0, h = y1 - y0;
  const a = arc ?? Math.max(4.0, Math.min(w, h) / 5.0);
  const pts: Pt[] = [];
  const sides: [number, number, number, number, number, number][] = [
    [x0, y0, x1, y0, 0, -1], [x1, y0, x1, y1, 1, 0], [x1, y1, x0, y1, 0, 1], [x0, y1, x0, y0, -1, 0],
  ];
  for (const [ax, ay, bx, by, nx, ny] of sides) {
    const L = Math.hypot(bx - ax, by - ay);
    if (L <= 0) continue;
    const n = Math.max(1, pyRound(L / a));
    const step = L / n, ux = (bx - ax) / L, uy = (by - ay) / L;
    for (let i = 0; i < n; i++) {
      const sx = ax + ux * step * i, sy = ay + uy * step * i;
      for (let j = 0; j < 9; j++) {
        const ang = (Math.PI * j) / 8;
        const a_ = (step * (1 - Math.cos(ang))) / 2;
        const o_ = ((Math.sin(ang) * step) / 2) * 0.9;
        pts.push([sx + ux * a_ + nx * o_, sy + uy * a_ + ny * o_]);
      }
    }
  }
  return pts;
}
/** (지시점 tip, 말풍선 가장자리 중앙 end) */
export function calloutLeader(m: Pick<Markup, "pts">): [Pt, Pt] {
  const [x0, y0, x1, y1] = normRect(m.pts[0], m.pts[1]);
  const [tx, ty] = m.pts[2];
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const w = Math.max(x1 - x0, 1e-6), h = Math.max(y1 - y0, 1e-6);
  let end: Pt;
  if (Math.abs(tx - cx) / w >= Math.abs(ty - cy) / h) end = tx < cx ? [x0, cy] : [x1, cy];
  else end = ty < cy ? [cx, y0] : [cx, y1];
  return [[tx, ty], end];
}
export function markupBBox(m: Pick<Markup, "kind" | "pts">): [number, number, number, number] {
  if (m.kind === "line" || m.kind === "arrow" || m.kind === "polygon") {
    const xs = m.pts.map((p) => p[0]), ys = m.pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  const [x0, y0, x1, y1] = normRect(m.pts[0], m.pts[1]);
  if (m.kind === "callout") {
    const [tx, ty] = m.pts[2];
    return [Math.min(x0, tx), Math.min(y0, ty), Math.max(x1, tx), Math.max(y1, ty)];
  }
  return [x0, y0, x1, y1];
}
/** 채움 없는 도형은 테두리 근처만, 채움 도형·텍스트는 영역 전체, 선·화살표는 선분 근처 */
export function hitMarkup(m: Markup, x: number, y: number, tol: number): boolean {
  const k = m.kind;
  if (k === "line" || k === "arrow") return segDist(x, y, m.pts[0][0], m.pts[0][1], m.pts[1][0], m.pts[1][1]) <= tol;
  const [x0, y0, x1, y1] = k !== "polygon" ? normRect(m.pts[0], m.pts[1]) : [0, 0, 0, 0];
  const filled = Boolean(m.style.fill);
  if (k === "textbox") return x0 - tol <= x && x <= x1 + tol && y0 - tol <= y && y <= y1 + tol;
  if (k === "callout") {
    if (x0 - tol <= x && x <= x1 + tol && y0 - tol <= y && y <= y1 + tol) return true;
    const [tip, end] = calloutLeader(m);
    return segDist(x, y, tip[0], tip[1], end[0], end[1]) <= tol;
  }
  if (k === "rect" || k === "cloud") {
    if (filled && x0 <= x && x <= x1 && y0 <= y && y <= y1) return true;
    return polylineDist(x, y, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true) <= tol;
  }
  if (k === "ellipse") {
    const poly = ellipsePoly(x0, y0, x1, y1);
    if (filled && pointInPoly(x, y, poly)) return true;
    return polylineDist(x, y, poly, true) <= tol;
  }
  if (k === "polygon") {
    if (filled && pointInPoly(x, y, m.pts)) return true;
    return polylineDist(x, y, m.pts, true) <= tol;
  }
  return false;
}
export function handlesOf(m: Markup): Record<string, Pt> {
  const k = m.kind;
  if (k === "line" || k === "arrow") return { p0: [m.pts[0][0], m.pts[0][1]], p1: [m.pts[1][0], m.pts[1][1]] };
  if (k === "polygon") return Object.fromEntries(m.pts.map((p, i) => [`v${i}`, [p[0], p[1]] as Pt]));
  const [x0, y0, x1, y1] = normRect(m.pts[0], m.pts[1]);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const h: Record<string, Pt> = {
    nw: [x0, y0], n: [cx, y0], ne: [x1, y0], e: [x1, cy], se: [x1, y1], s: [cx, y1], sw: [x0, y1], w: [x0, cy],
  };
  if (k === "callout") h.tip = [m.pts[2][0], m.pts[2][1]];
  return h;
}
export function hitHandle(m: Markup, x: number, y: number, tol: number): string | null {
  let best: string | null = null;
  let bd = tol * 1.2;
  for (const [name, [hx, hy]] of Object.entries(handlesOf(m))) {
    const d = Math.hypot(x - hx, y - hy);
    if (d <= bd) {
      best = name;
      bd = d;
    }
  }
  return best;
}
export function dragHandle(snap: Pt[], name: string, x: number, y: number, minSize = 2.0): Pt[] {
  const pts: Pt[] = snap.map((p) => [p[0], p[1]]);
  if (name === "p0" || name === "p1") pts[name === "p0" ? 0 : 1] = [x, y];
  else if (name.startsWith("v")) pts[parseInt(name.slice(1), 10)] = [x, y];
  else if (name === "tip") pts[2] = [x, y];
  else {
    let [x0, y0, x1, y1] = normRect(snap[0], snap[1]);
    if (name.includes("w")) x0 = Math.min(x, x1 - minSize);
    if (name.includes("e")) x1 = Math.max(x, x0 + minSize);
    if (name.includes("n")) y0 = Math.min(y, y1 - minSize);
    if (name.includes("s")) y1 = Math.max(y, y0 + minSize);
    pts[0] = [x0, y0];
    pts[1] = [x1, y1];
  }
  return pts;
}

// ---------------------------------------------------------------- 비교 돋보기 카드 (엔진 2부 그대로)
export function cardRegionOrigin(cxPt: number, cyPt: number, mag: number, pw: number, ph: number): [number, number] {
  return [Math.floor(cxPt * mag - pw / 2.0), Math.floor(cyPt * mag - ph / 2.0)];
}
type Rect4 = [number, number, number, number];
export function chooseCardPosition(container: [number, number], card: [number, number], anchor: Rect4, avoid: Rect4[], gap = 12): [number, number] {
  const [cw, ch] = container;
  const [w, h] = card;
  const [ax0, ay0, ax1, ay1] = anchor;
  const acx = (ax0 + ax1) / 2, acy = (ay0 + ay1) / 2;
  const cands: [number, number][] = [
    [ax1 + gap, acy - h / 2], [ax0 - gap - w, acy - h / 2], [acx - w / 2, ay1 + gap], [acx - w / 2, ay0 - gap - h],
    [ax1 + gap, ay0], [ax0 - gap - w, ay0],
  ];
  const cl = (p: [number, number]): [number, number] => [Math.min(Math.max(p[0], 0), Math.max(cw - w, 0)), Math.min(Math.max(p[1], 0), Math.max(ch - h, 0))];
  const overlap = (p: [number, number], r: Rect4): number => {
    const ix = Math.max(0, Math.min(p[0] + w, r[2]) - Math.max(p[0], r[0]));
    const iy = Math.max(0, Math.min(p[1] + h, r[3]) - Math.max(p[1], r[1]));
    return ix * iy;
  };
  let best: [number, number] = [0, 0];
  let bestCost: number | null = null;
  for (const c of cands) {
    const p = cl(c);
    let cost = overlap(p, anchor) * 4 + avoid.reduce((s, r) => s + overlap(p, r), 0);
    cost += (Math.abs(p[0] - c[0]) + Math.abs(p[1] - c[1])) * 0.01;
    if (bestCost === null || cost < bestCost) {
      best = p;
      bestCost = cost;
    }
    if (cost === 0) break;
  }
  return [Math.trunc(best[0]), Math.trunc(best[1])];
}
export function clampCardSize(w: number, h: number, hostW: number, hostH: number, x = 0, y = 0): [number, number] {
  const maxW = Math.max(CARD_MIN_W, Math.trunc(hostW - x));
  const maxH = Math.max(CARD_MIN_H, Math.trunc(hostH - y));
  return [Math.trunc(Math.min(Math.max(w, CARD_MIN_W), maxW)), Math.trunc(Math.min(Math.max(h, CARD_MIN_H), maxH))];
}
export function suitableCardSize(hostW: number, hostH: number): [number, number] {
  const w = Math.min(Math.max(Math.trunc(hostW * 0.6), 560), 800);
  const h = Math.min(Math.max(Math.trunc(hostH * 0.55), 320), 460);
  return clampCardSize(w, h, hostW, hostH);
}
export function clampCardPos(x: number, y: number, w: number, h: number, hostW: number, hostH: number): [number, number] {
  return [Math.trunc(Math.min(Math.max(x, 0), Math.max(hostW - w, 0))), Math.trunc(Math.min(Math.max(y, 0), Math.max(hostH - h, 0)))];
}

export const ptsToSvg = (pts: Pt[]): string => pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ");
export const pxToMm = (px: number, dpi: number): number => (px / dpi) * 25.4;
