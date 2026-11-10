"use client";

// 기존 프로그램(5부 App) 배치를 그대로 옮긴 웹 화면.
// 왼쪽 슬라이드 메뉴(Push) / 위 툴바 3줄 / 도면 뷰어 / 아래 통계 줄 + 웹 전용 오른쪽 검토 패널.
// 비교·정렬·검출·AI 판정은 모두 서버(기존 엔진)가 수행한다.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as RDragEvent, type PointerEvent as RPointerEvent } from "react";
import { CompareCard, cardRegionPx, type CardState } from "@/components/CompareCard";
import { PropertyPanel, type PropTarget } from "@/components/PropertyPanel";
import { AlignBadge, REVIEW_KO, ReviewPanel } from "@/components/ReviewPanel";
import { ToolIcon } from "@/components/ToolIcon";
import { Viewer } from "@/components/Viewer";
import { api, ApiError, downloadUrl, errText, pageImageUrl } from "@/lib/api";
import {
  BUBBLE_MAX_DISPLAY, BUBBLE_RADIUS_PX, CARD_CONTEXT_MM, CARD_DEFAULT_SIZE, CARD_MAG_DEFAULT, CARD_MAG_MAX, CARD_MAG_MIN, FILL_TOOLS,
  POLICY_REASON, TOOL_HINT, TOOL_LABEL, centerOn, chooseCardPosition, clamp, clampCardPos, clampCardSize, suitableCardSize, zoomAt, type View,
} from "@/lib/geometry";
import type { AiStatus, AppSettings, Bubble, Change, Colors, Comparison, DocumentInfo, Markup, MarkupKind, MarkupStyle, Project, Pt, ViewMode } from "@/lib/types";
import { REVIEW_STATUSES, TOOLS } from "@/lib/types";

const MENU_PIN_MIN_WINDOW = 900;
const MAX_BASE_PX = 4096;
const READY = "PDF 두 개를 불러온 뒤 비교를 시작하세요";
const isTyping = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
const tolLabel = (t: number): string => (t === 0 ? "0 mm (정확히)" : t === 0.25 ? `${t} mm (기본)` : `${t} mm`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function triggerDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function App() {
  // ------------------------------------------------------------------ 기본 상태
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [history, setHistory] = useState<Comparison[]>([]);
  const [files, setFiles] = useState<{ old: DocumentInfo | null; new: DocumentInfo | null }>({ old: null, new: null });
  const [dpi, setDpi] = useState(200);
  const [tolMm, setTolMm] = useState(0.25);
  const [autoAlign, setAutoAlign] = useState(true);
  const [colors, setColors] = useState<Colors>({ old: "#A0A0A0", new: "#000000", changed: "#E0245E" });
  const [csel, setCsel] = useState<Colors>({ old: "#A0A0A0", new: "#000000", changed: "#E0245E" });
  const [toolDefaults, setToolDefaults] = useState<Record<MarkupKind, MarkupStyle> | null>(null);
  const [status, setStatusText] = useState(READY);
  const [statusErr, setStatusErr] = useState(false);
  const [progress, setProgress] = useState(0);
  const [notice, setNoticeText] = useState("");
  const noticeJob = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [busy, setBusy] = useState(false);

  // 메뉴
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPinned, setMenuPinned] = useState(false);
  const [menuWidth, setMenuWidth] = useState(400);
  const [dropHi, setDropHi] = useState(false);

  // 비교 결과·화면
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [page, setPage] = useState(0);
  const [mode, setMode] = useState<ViewMode>("overlay");
  const [side, setSide] = useState(false);
  const [sideAligned, setSideAligned] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [host, setHost] = useState<[number, number]>([800, 600]);
  const [fitSignal, setFitSignal] = useState(0);
  const [showBubbles, setShowBubbles] = useState(true);
  const [showDiffBox, setShowDiffBox] = useState(false);
  const [boxZoom, setBoxZoom] = useState(false);
  const [magnifier, setMagnifier] = useState(false);
  const [bubbles, setBubbles] = useState<Bubble[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showFailed, setShowFailed] = useState<Record<number, boolean>>({});
  const [cursor, setCursor] = useState<Pt | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(true);
  const [reviewer, setReviewerState] = useState("");

  // 마크업
  const [markups, setMarkups] = useState<Record<number, Markup[]>>({});
  const [sel, setSel] = useState(-1);
  const [tool, setToolState] = useState<MarkupKind | null>(null);
  const [propsOpen, setPropsOpen] = useState(false);
  const [saveState, setSaveState] = useState("");
  const dirty = useRef<Set<number>>(new Set());
  const saveJob = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markupsRef = useRef(markups);
  markupsRef.current = markups;

  // 비교 돋보기
  const [card, setCard] = useState<CardState | null>(null);
  const [cardPane, setCardPane] = useState<[number, number]>([300, 250]);
  const pinnedGeom = useRef<[number, number, number, number] | null>(null);
  const cardLayout = useRef<"h" | "v">("h");
  // 비교 돋보기: 마지막 가로/세로와 고정 위치·크기를 브라우저에 기억 (닫기·재비교·프로그램 재실행 후에도 유지)
  useEffect(() => {
    try {
      cardLayout.current = window.localStorage.getItem("dac.card.layout") === "v" ? "v" : "h";
      const g: unknown = JSON.parse(window.localStorage.getItem("dac.card.pinned") ?? "null");
      if (Array.isArray(g) && g.length === 4 && g.every((n) => typeof n === "number" && Number.isFinite(n)))
        pinnedGeom.current = g as [number, number, number, number];
    } catch {
      /* 저장값이 손상되면 기본값(가로, 고정 안 함) 사용 */
    }
  }, []);
  const restartSize = useRef<[number, number] | null>(null);

  useEffect(() => {
    if (!card) return;
    cardLayout.current = card.layout;
    window.localStorage.setItem("dac.card.layout", card.layout);
    if (card.pinned) {
      pinnedGeom.current = [card.x, card.y, card.w, card.h];
      window.localStorage.setItem("dac.card.pinned", JSON.stringify(pinnedGeom.current));
    } else {
      pinnedGeom.current = null;
      window.localStorage.removeItem("dac.card.pinned");
    }
  }, [card]);
  // AI 키 입력 창
  const [keyDlg, setKeyDlg] = useState(false);
  const [keyVal, setKeyVal] = useState("");
  // 오른쪽 클릭 메뉴 (변경 영역 삭제/복원)
  const [ctx, setCtx] = useState<{ x: number; y: number; change: Change } | null>(null);

  const setStatus = useCallback((t: string, error = false) => {
    setStatusText(t);
    setStatusErr(error);
  }, []);
  const showNotice = useCallback((t: string, ms = 7000) => {
    setNoticeText(t);
    if (noticeJob.current) clearTimeout(noticeJob.current);
    noticeJob.current = setTimeout(() => setNoticeText(""), ms);
  }, []);

  // ------------------------------------------------------------------ 시작
  const loadProjectData = useCallback(async (p: Project) => {
    setProject(p);
    window.localStorage.setItem("dac.project", p.id);
    setHistory(await api.listComparisons(p.id));
  }, []);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    setReviewerState(window.localStorage.getItem("dac.reviewer") ?? "");
    (async () => {
      try {
        const [s, a, ps0] = await Promise.all([api.settings(), api.aiStatus(), api.listProjects()]);
        setSettings(s);
        setAi(a);
        setDpi(s.dpi);
        setTolMm(s.tol_mm);
        setAutoAlign(s.auto_align);
        setColors(s.colors);
        setCsel(s.colors);
        setToolDefaults(s.tool_defaults);
        setMenuWidth(s.menu_width);
        restartSize.current = s.compare_card_size;
        let ps = ps0;
        if (ps.length === 0) ps = [await api.createProject("기본 프로젝트")];
        setProjects(ps);
        const last = window.localStorage.getItem("dac.project");
        await loadProjectData(ps.find((x) => x.id === last) ?? ps[0]);
        if (s.settings_warnings.length) setStatus("설정 파일 경고: " + s.settings_warnings.join(" / "));
        const pinned = s.menu_pinned && window.innerWidth >= MENU_PIN_MIN_WINDOW;
        setMenuPinned(pinned);
        const cid = new URLSearchParams(window.location.search).get("c");
        if (cid) await openComparison(cid, pinned);
        else if (!pinned) setTimeout(() => setMenuOpen(true), 250);          // 시작 시 PDF가 없으면 메뉴 자동 열림
        else setMenuOpen(true);
      } catch (e) {
        setStatus(errText(e), true);
        setMenuOpen(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isOpen = menuOpen || menuPinned;
  const persist = useCallback(async (patch: Parameters<typeof api.patchSettings>[0]) => {
    try {
      setSettings(await api.patchSettings(patch));
    } catch (e) {
      showNotice(`설정 저장 실패: ${errText(e)}`);
    }
  }, [showNotice]);

  // 창 폭이 작아지면 메뉴 고정 해제 (기존 _on_window_configure)
  useEffect(() => {
    const onResize = () => {
      if (menuPinned && window.innerWidth < MENU_PIN_MIN_WINDOW) {
        setMenuPinned(false);
        setMenuOpen(true);
        showNotice(`창 폭이 ${MENU_PIN_MIN_WINDOW}px 미만이라 메뉴 고정을 해제했습니다`);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [menuPinned, showNotice]);

  const pg = cmp?.pages[page] ?? null;
  const k = (cmp?.settings.dpi ?? 200) / 72;
  const pageChanges = useMemo(() => changes.filter((c) => c.baseline_page === page), [changes, page]);
  /** 화면 표시용 (오른쪽 클릭으로 삭제한 영역 제외). 자동 탐지 결과는 서버에 그대로 남아 있다 */
  const visibleChanges = useMemo(() => pageChanges.filter((c) => !c.review.dismissed), [pageChanges]);
  const selected = changes.find((c) => c.change_id === selectedId) ?? null;
  const alignFailedHidden = pg?.alignment.status === "Alignment Failed" && !showFailed[page];
  const locked = Boolean(cmp?.review_completed_at);
  const pageMarkups = markups[page] ?? [];

  // ------------------------------------------------------------------ 파일
  async function loadPdf(which: "old" | "new", f: File) {
    if (!project) return;
    if (!f.name.toLowerCase().endsWith(".pdf")) {
      window.alert("PDF 열기 오류\n\nPDF 파일이 아닙니다.");
      return;
    }
    if (settings && f.size > settings.max_upload_mb * 1048576) {
      window.alert(`PDF 열기 오류\n\n파일이 너무 큽니다 (최대 ${settings.max_upload_mb}MB)`);
      return;
    }
    setStatus(`${which.toUpperCase()} 불러오는 중… ${f.name}`);
    try {
      const d = await api.uploadDocument(project.id, f);
      if (d.origin_hint === "result" && !window.confirm(`'${d.original_name}' 은(는) 이 프로그램이 저장한 'Overlay 결과' PDF입니다.\n비교 결과 화면이 ${which.toUpperCase()} 도면으로 표시됩니다.\n\n그래도 ${which.toUpperCase()} 로 불러오시겠습니까?`)) {
        setStatus(READY);
        return;
      }
      setFiles((x) => ({ ...x, [which]: d }));
      setStatus(`${which.toUpperCase()} 불러옴: ${d.original_name} (${d.page_count}p)`);
      if (d.origin_hint === "image_only") showNotice(`${which.toUpperCase()} PDF는 페이지 전체가 이미지 1장입니다. 스캔 도면이거나 Overlay 결과 PDF일 수 있으니 원본이 맞는지 확인하세요.`, 12000);
    } catch (e) {
      setStatus(errText(e), true);
      window.alert(`PDF 열기 오류\n\n${errText(e)}`);
    }
  }
  function pick(which: "old" | "new") {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".pdf,application/pdf";
    inp.onchange = () => inp.files?.[0] && void loadPdf(which, inp.files[0]);
    inp.click();
  }
  function onWindowDrop(e: RDragEvent) {
    e.preventDefault();
    setDropHi(false);
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const which = !files.old ? "old" : !files.new ? "new" : null;
    if (!which) showNotice("교체하려면 OLD / NEW 카드 위에 PDF를 놓으세요");
    else void loadPdf(which, f);
  }

  // ------------------------------------------------------------------ 비교
  const openComparison = useCallback(async (id: string, keepMenu = menuPinned) => {
    const c = await api.getComparison(id);
    if (c.state !== "succeeded") throw new ApiError(409, c.error ?? `비교 상태: ${c.state}`);
    const [ch, od, nd] = await Promise.all([api.listChanges(id), api.getDocument(c.baseline_document.id), api.getDocument(c.comparison_document.id)]);
    const mk: Record<number, Markup[]> = {};
    await Promise.all(c.pages.map(async (p) => (mk[p.page_index] = (await api.getMarkups(id, p.page_index)).markups)));
    dirty.current.clear();
    setCmp(c);
    setChanges(ch);
    setMarkups(mk);
    setFiles({ old: od, new: nd });
    setPage(0);
    setMode("overlay");
    setSide(false);
    setView(null);
    setSel(-1);
    setSelectedId(null);
    setShowFailed({});
    setCard(null);
    setAiNote(null);
    setProgress(100);
    if (!keepMenu) setMenuOpen(false);                                      // 비교 완료 시 자동 닫힘 (핀 모드는 유지)
    const n = c.pages.reduce((s, p) => s + p.change_count, 0);
    setStatus(`비교 완료: ${c.pages.length}페이지, 변경 영역 ${n}개`);
    window.history.replaceState(null, "", `?c=${id}`);
  }, [menuPinned, setStatus]);

  async function startCompare() {
    if (busy || !project) return;
    if (!files.old || !files.new) {
      window.alert("안내\n\nOld / New PDF를 모두 불러오세요.");
      return;
    }
    setBusy(true);
    setProgress(0);
    setStatus("비교 중…");
    try {
      let j = await api.createComparison({ project_id: project.id, baseline_document_id: files.old.id, comparison_document_id: files.new.id, dpi, auto_align: autoAlign, tol_mm: tolMm, colors });
      while (j.state === "queued" || j.state === "running") {
        await sleep(300);
        j = await api.getStatus(j.id);
        setStatus(j.stage);
        if (j.page_total) setProgress((100 * j.page_done) / j.page_total);
      }
      if (j.state === "failed") throw new Error(j.error ?? "비교 실패");
      await openComparison(j.id);
      setHistory(await api.listComparisons(project.id));
    } catch (e) {
      setStatus(errText(e), true);
      setMenuOpen(true);                                                   // 비교 실패 시 메뉴 자동 열림
      window.alert(`비교 실패\n\n${errText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------ 마크업 자동 저장 (서버에 New 페이지 좌표로 보관)
  const flushMarkups = useCallback(async (): Promise<boolean> => {
    if (saveJob.current) clearTimeout(saveJob.current);
    if (!cmp || dirty.current.size === 0) return true;
    setSaveState("마크업 저장 중…");
    try {
      for (const p of Array.from(dirty.current)) {
        await api.putMarkups(cmp.id, p, markupsRef.current[p] ?? []);
        dirty.current.delete(p);
      }
      setSaveState("마크업 저장됨");
      return true;
    } catch (e) {
      setSaveState("마크업 저장 실패");
      showNotice(`마크업 저장 실패: ${errText(e)}`, 12000);
      return false;
    }
  }, [cmp, showNotice]);

  const onMarkups = useCallback((ms: Markup[], s: number) => {
    setMarkups((m) => ({ ...m, [page]: ms }));
    setSel(s);
    dirty.current.add(page);
    setSaveState("저장되지 않은 변경 있음");
    if (saveJob.current) clearTimeout(saveJob.current);
    saveJob.current = setTimeout(() => void flushMarkups(), 700);
  }, [page, flushMarkups]);

  const permission = (region: "old" | "new" | "overlay" | "side_old" | "side_new"): [boolean, string] => {
    if (!cmp) return [false, POLICY_REASON.nocompare];
    if (region === "old" || region === "side_old") return [false, POLICY_REASON[region]];
    if (!pg?.new_exists) return [false, POLICY_REASON.blank];
    return [true, ""];
  };
  const [editOk, editWhy] = permission(side ? "side_new" : mode);

  function toggleTool(kind: MarkupKind) {
    if (tool === kind) {
      setToolState(null);
      return;
    }
    if (!editOk) {
      showNotice(editWhy || "이 화면에서는 마크업을 작성할 수 없습니다");
      return;
    }
    setToolState(kind);
    setSel(-1);
    setBoxZoom(false);
    setMagnifier(false);
    showNotice(TOOL_HINT[kind]);
  }
  const setTool = useCallback((t: MarkupKind | null) => setToolState(t), []);
  const toolStyle = useCallback((kk: MarkupKind): MarkupStyle => toolDefaults?.[kk] ?? { fill: null, stroke: "#0000FF", width: 1, text_color: "#000000", font: "Arial", font_size: 12 }, [toolDefaults]);

  // ------------------------------------------------------------------ 보기
  const imgW = pg?.size_px[0] ?? 1;
  const imgH = pg?.size_px[1] ?? 1;
  const baseScale = Math.min(1, MAX_BASE_PX / Math.max(imgW, imgH));
  const scale = view && view.zoom > baseScale * 1.25 ? 1 : baseScale;      // 확대하면 원본 해상도 이미지로 교체
  const onView = useCallback((v: View) => setView(v), []);
  const onHost = useCallback((w: number, h: number) => setHost([w, h]), []);
  const onCardPane = useCallback((w: number, h: number) => setCardPane([w, h]), []);

  // 변경 알림(숫자): 기존 place_bubbles 를 서버에서 실행 (배율에 따라 위치가 달라짐)
  const bubblesOn = Boolean(cmp && pg && showBubbles && !side && mode !== "old" && !alignFailedHidden && pg.change_count > 0 && pg.change_count <= BUBBLE_MAX_DISPLAY);
  const shownBubbles = useMemo(() => {
    if (!bubbles) return null;
    const keep = new Set(visibleChanges.map((c) => c.detection.region_no));
    return bubbles.filter((b) => keep.has(b.region_no));
  }, [bubbles, visibleChanges]);
  const zoomKey = view ? Math.round(view.zoom * 1e5) / 1e5 : 0;
  useEffect(() => {
    if (!bubblesOn || !cmp || !zoomKey) {
      setBubbles(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api.bubbles(cmp.id, page, zoomKey).then((b) => live && setBubbles(b), (e: unknown) => live && showNotice(errText(e)));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [bubblesOn, cmp, page, zoomKey, showNotice]);

  function gotoPage(p: number) {
    if (!cmp) return;
    p = clamp(p, 0, cmp.pages.length - 1);
    if (p === page) return;
    void flushMarkups();
    setPage(p);
    setView(null);
    setSel(-1);
    setAiNote(null);
    if (card) setCard(card.pinned ? { ...card, page: p } : null);
  }

  // ------------------------------------------------------------------ 비교 돋보기
  function estPane(c: { w: number; h: number; layout: "h" | "v" }): [number, number] {
    const vert = c.layout === "v";
    const w = vert ? c.w - 24 : Math.floor((c.w - 24) / 2);
    const h = vert ? Math.floor((c.h - 120) / 2) : c.h - 96;
    return [Math.max(60, w - 6), Math.max(60, h - 6)];
  }
  function openCard(p: number, cx: number, cy: number, mag: number | null, regionNo: number | null, anchor: [number, number, number, number]) {
    const [hw, hh] = host;
    const avoid: [number, number, number, number][] = propsOpen ? [[hw - 151, 0, hw, hh]] : [];
    const near = (w: number, h: number) => chooseCardPosition([hw, hh], [w, h], anchor, avoid);
    let x: number, y: number, w: number, h: number;
    if (card) {
      [w, h] = clampCardSize(card.w, card.h, hw, hh);
      [x, y] = card.pinned ? [card.x, card.y] : near(w, h);
    } else if (pinnedGeom.current) {
      const g = pinnedGeom.current;
      [w, h] = clampCardSize(g[2], g[3], hw, hh);
      [x, y] = clampCardPos(g[0], g[1], w, h, hw, hh);
    } else {
      if (restartSize.current) {
        [w, h] = clampCardSize(restartSize.current[0], restartSize.current[1], hw, hh);
        restartSize.current = null;
      } else [w, h] = suitableCardSize(hw, hh);
      [x, y] = near(w, h);
    }
    setCard({ page: p, cx, cy, mag: clamp(mag ?? card?.mag ?? CARD_MAG_DEFAULT, CARD_MAG_MIN, CARD_MAG_MAX), regionNo, layout: card?.layout ?? cardLayout.current, pinned: card?.pinned ?? Boolean(pinnedGeom.current), x, y, w, h });
  }
  function closeCard() {
    if (card) pinnedGeom.current = card.pinned ? [card.x, card.y, card.w, card.h] : null;
    if (card && !card.pinned) restartSize.current = null;
    setCard(null);
  }
  function openCardForRegion(regionNo: number) {
    const c = visibleChanges.find((x) => x.detection.region_no === regionNo);
    if (!c || !cmp || !view) return;
    setSelectedId(c.change_id);
    setAiNote(c.ai ? `${c.ai.label}\n설명 : ${c.ai.summary}` : null);
    const b = c.detection.bounding_box_px;
    const wPt = (b.x1 - b.x0) / k, hPt = (b.y1 - b.y0) / k;
    const ctx = (CARD_CONTEXT_MM / 25.4) * 72.0;
    const [pw, ph] = card ? cardPane : estPane({ w: CARD_DEFAULT_SIZE[0], h: CARD_DEFAULT_SIZE[1], layout: cardLayout.current });
    const mag = clamp(Math.min(pw / (wPt + 2 * ctx), ph / (hPt + 2 * ctx)), CARD_MAG_MIN, CARD_MAG_MAX);
    const R2 = BUBBLE_RADIUS_PX * 2;
    const a = [(b.x0 - view.ox) * view.zoom, (b.y0 - view.oy) * view.zoom], e = [(b.x1 - view.ox) * view.zoom, (b.y1 - view.oy) * view.zoom];
    openCard(page, (b.x0 + b.x1) / 2 / k, (b.y0 + b.y1) / 2 / k, mag, regionNo, [a[0] - R2, a[1] - R2, e[0] + R2, e[1] + R2]);
  }
  function onMagClick(ix: number, iy: number) {
    if (!cmp || !pg || !view) return;
    if (!side && mode === "old" && pg.alignment.engine_adopted && pg.alignment.matrix) {   // Old 화면 좌표 → New 기준
      const M = pg.alignment.matrix;
      [ix, iy] = [M[0][0] * ix + M[0][1] * iy + M[0][2], M[1][0] * ix + M[1][1] * iy + M[1][2]];
    }
    const sx = (ix - view.ox) * view.zoom, sy = (iy - view.oy) * view.zoom;
    openCard(page, ix / k, iy / k, null, null, [sx - 14, sy - 14, sx + 14, sy + 14]);
  }

  // ------------------------------------------------------------------ 변경 영역 이동·판정
  const goTo = useCallback((c: Change) => {
    setSelectedId(c.change_id);
    setAiNote(c.ai ? `${c.ai.label}\n설명 : ${c.ai.summary}` : null);
    if (c.baseline_page !== page) {
      setPage(c.baseline_page);
      setView(null);
      return;
    }
    const b = c.detection.bounding_box_px;
    setView((v) => (v ? centerOn(v, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, host[0], host[1]) : v));
  }, [page, host]);
  const onSaved = useCallback(async (c: Change) => {
    setChanges((cs) => cs.map((x) => (x.change_id === c.change_id ? c : x)));
    try {
      setCmp(await api.getComparison(c.comparison_id));
    } catch (e) {
      showNotice(errText(e));
    }
  }, [showNotice]);

  // ------------------------------------------------------------------ 오른쪽 클릭 삭제 (변경 없음) / 복원
  const openRegionMenu = useCallback((regionNo: number, x: number, y: number) => {
    const c = pageChanges.find((q) => q.detection.region_no === regionNo);
    if (c) {
      setSelectedId(c.change_id);
      setCtx({ x, y, change: c });
    }
  }, [pageChanges]);
  async function dismissOrRestore(c: Change) {
    setCtx(null);
    if (locked) {
      showNotice("검토 완료된 비교입니다. 먼저 검토 완료를 해제하세요");
      return;
    }
    try {
      const r = c.review.dismissed ? await api.restoreChange(c.change_id, reviewer || null) : await api.dismissChange(c.change_id, reviewer || null);
      await onSaved(r);
      // v0.4.2: 삭제해도 열려 있는 비교 돋보기는 닫지 않는다 (삭제 후에도 그 위치를 계속 확인할 수 있게)
      showNotice(c.review.dismissed ? `변경 #${c.detection.region_no} 복원 (이력: 삭제 복원)` : `변경 #${c.detection.region_no} 삭제 – 판정: 변경 없음 (이력: 사용자 삭제). 검토 패널 '삭제됨'에서 복원할 수 있습니다`);
    } catch (e) {
      showNotice(errText(e), 12000);
    }
  }
  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setCtx(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [ctx]);

  // ------------------------------------------------------------------ 키보드
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "b" || e.key === "B") && e.ctrlKey) {
        e.preventDefault();
        if (menuPinned) {
          setMenuPinned(false);
          setMenuOpen(false);
          void persist({ menu_pinned: false });
        } else setMenuOpen((o) => !o);
        return;
      }
      if (isTyping(e.target)) return;
      if (e.key === "Escape" && menuOpen && !menuPinned) setMenuOpen(false);
      const vis = alignFailedHidden ? [] : visibleChanges;
      if ((e.key === "n" || e.key === "p") && vis.length) {
        const i = vis.findIndex((c) => c.change_id === selectedId);
        const d = e.key === "n" ? 1 : -1;
        goTo(vis[i < 0 ? (d > 0 ? 0 : vis.length - 1) : (i + d + vis.length) % vis.length]);
      } else if (selected && !locked && /^[0-4]$/.test(e.key) && !e.ctrlKey) {
        const st = REVIEW_STATUSES.find((s) => REVIEW_KO[s].key === e.key);
        if (st) api.patchChange(selected.change_id, { status: st, reviewer: reviewer || undefined }).then((c) => void onSaved(c), (x: unknown) => showNotice(errText(x)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen, menuPinned, persist, visibleChanges, selectedId, selected, locked, reviewer, goTo, onSaved, showNotice, alignFailedHidden]);

  // ------------------------------------------------------------------ 저장 (기존 SAVE RESULT AS PDF)
  async function saveResult() {
    if (!cmp) {
      window.alert("안내\n\nPDF 비교를 먼저 실행하세요.");
      return;
    }
    if (side || mode === "old") {
      window.alert("저장 안내\n\nOld 화면에서는 저장하지 않습니다. NEW 또는 OVERLAY 화면에서 저장하세요.");
      return;
    }
    if (!(await flushMarkups())) return;
    setStatus("저장 중…");
    try {
      const ex = await api.createExport(cmp.id, mode === "new" ? "new_pdf" : "overlay_pdf", mode === "overlay" ? colors : null);
      const target = mode === "new" ? "New 문서" : "Overlay 결과";
      triggerDownload(downloadUrl(ex.download_url));
      setStatus(`저장 완료: ${target} → ${ex.file_name}`);
      let msg = `저장 대상: ${target}\n파일: ${ex.file_name}\n재열기 검증: 페이지 ${ex.verification?.pages ?? "?"}개 / 마크업 주석 ${ex.verification?.annots ?? "?"}개 일치\n\n참고\n· 글꼴은 PDF 주석 제한으로 Arial→Helvetica, Times New Roman→Times-Roman, Courier New→Courier 로 대체(비임베드)됩니다. 한글 등은 대체 CJK 글꼴로 기록되므로 외부 PDF 뷰어에서 표시를 확인하세요.\n· 텍스트 상자·설명선의 테두리 색은 외관 스트림에 직접 기록했습니다. 일부 뷰어가 주석 편집 시 외관을 다시 만들면 달라질 수 있습니다.`;
      if (mode === "overlay") msg += "\n· Overlay 결과 PDF는 비교 결과이므로 Old/New 도면 원본으로 다시 불러오지 마세요.";
      window.alert(`저장 완료\n\n${msg}`);
    } catch (e) {
      setStatus(`저장 실패: ${errText(e)}`, true);
      window.alert(`저장 실패\n\n${errText(e)}`);
    }
  }
  async function exportJson() {
    if (!cmp) return;
    try {
      await flushMarkups();
      triggerDownload(downloadUrl((await api.createExport(cmp.id, "result_json", null)).download_url));
    } catch (e) {
      showNotice(errText(e));
    }
  }

  // ------------------------------------------------------------------ AI 검증 (기존 4-b부: 비용 추정 → 사용자 확인 → 호출)
  async function startAi() {
    if (!cmp) {
      window.alert("안내\n\nPDF 비교를 먼저 실행하세요.");
      return;
    }
    setStatus("AI 비용 계산 중…");
    let run;
    try {
      run = await api.aiEstimate(cmp.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setStatus(e.detail);
        showNotice(e.detail);
      } else {
        setStatus(errText(e), true);
        window.alert(`AI 검증\n\n${errText(e)}\n\n이미 받은 결과는 유지됩니다.`);
      }
      return;
    }
    if (!window.confirm(`AI 검증\n\n${run.confirm_text}`)) {
      await api.aiCancel(run.id).catch(() => undefined);
      setStatus("AI 검증을 취소했습니다");
      return;
    }
    try {
      run = await api.aiStart(run.id);
      while (run.state === "running") {
        setStatus(`AI 검증 중… (${run.jobs_done}/${run.n_jobs} 묶음)`);
        setProgress((100 * run.jobs_done) / Math.max(run.n_jobs, 1));
        await sleep(700);
        run = await api.aiRun(run.id);
      }
      setProgress(100);
      setChanges(await api.listChanges(cmp.id));
      if (run.state === "succeeded") setStatus(`AI 검증 완료: ${run.results}개 영역`);
      else {
        setStatus(run.error ?? "AI 검증 실패", true);
        window.alert(`AI 검증\n\n${run.error ?? "실패"}\n\n이미 받은 결과는 유지됩니다.`);
      }
    } catch (e) {
      setStatus(errText(e), true);
    }
  }
  async function saveKey() {
    try {
      setAi(await api.aiSetKey(keyVal));
      showNotice(keyVal.trim() ? "API 키를 저장했습니다" : "저장된 API 키를 지웠습니다");
      setKeyDlg(false);
      setKeyVal("");
    } catch (e) {
      window.alert(`Claude API 키\n\n${errText(e)}`);
    }
  }

  // ------------------------------------------------------------------ 메뉴 폭 조절
  const rs = useRef<{ x: number; w: number } | null>(null);
  const range = settings?.menu_width_range ?? [320, 560];
  const onRsDown = (e: RPointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    rs.current = { x: e.clientX, w: menuWidth };
  };
  const onRsMove = (e: RPointerEvent) => rs.current && setMenuWidth(clamp(rs.current.w + e.clientX - rs.current.x, range[0], range[1]));
  const onRsUp = () => {
    if (rs.current) void persist({ menu_width: Math.round(menuWidth) });
    rs.current = null;
  };

  // ------------------------------------------------------------------ 표시
  const stats = pg
    ? [
        `unchanged: ${pg.stats.unchanged.toLocaleString()}`, `removed: ${pg.stats.removed.toLocaleString()}`, `added: ${pg.stats.added.toLocaleString()}`,
        `정렬: ${pg.alignment.engine_reason}`, `허용 오차: ${cmp?.settings.tol_mm} mm`,
        ...(!pg.old_exists ? ["Old 문서에 없는 페이지(빈 페이지로 비교)"] : []), ...(!pg.new_exists ? ["New 문서에 없는 페이지(빈 페이지로 비교)"] : []),
        pg.change_count > BUBBLE_MAX_DISPLAY ? `변경 영역 ${pg.change_count}개 (너무 많아 숫자 버블 미표시)` : `변경 영역 ${pg.change_count}개`,
          ...(pageChanges.length - visibleChanges.length ? [`사용자 삭제 ${pageChanges.length - visibleChanges.length}개 (변경 없음)`] : []),
      ].join("   |   ")
    : "";
  const saveTarget = !cmp ? "현재 화면 기준 저장 대상: (비교 후 표시)" : side || mode === "old" ? "현재 화면 기준 저장 대상: 없음 (Old 화면은 저장하지 않음)" : mode === "new" ? "현재 화면 기준 저장 대상: New 문서 (+ 마크업)" : "현재 화면 기준 저장 대상: Overlay 결과 (+ New 마크업)";
  const nMarkups = Object.values(markups).reduce((s, m) => s + m.length, 0);
  const colorName = (h: string) => Object.entries(settings?.color_choices ?? {}).find(([, v]) => v.toUpperCase() === h.toUpperCase())?.[0] ?? h.toUpperCase();

  const propTarget: PropTarget =
    sel >= 0 && pageMarkups[sel] && editOk ? { kind: "markup", mk: pageMarkups[sel].kind, style: pageMarkups[sel].style }
      : tool ? { kind: "default", mk: tool, style: toolStyle(tool) } : null;
  function applyProp(part: Partial<MarkupStyle>) {
    if (propTarget?.kind === "markup") {
      const m = pageMarkups[sel];
      const style = { ...m.style, ...part };
      if (!FILL_TOOLS.includes(m.kind)) style.fill = null;
      onMarkups(pageMarkups.map((x, i) => (i === sel ? { ...x, style } : x)), sel);
    } else if (propTarget?.kind === "default" && toolDefaults) {
      setToolDefaults({ ...toolDefaults, [propTarget.mk]: { ...toolDefaults[propTarget.mk], ...part } });
      showNotice(`${TOOL_LABEL[propTarget.mk]} 기본값을 적용했습니다 (파일 저장은 '도구 기본값 저장')`);
    }
  }
  async function saveDefault(kind: MarkupKind, style: MarkupStyle) {
    try {
      const s = await api.patchSettings({ tool_defaults: { [kind]: style } });
      setSettings(s);
      setToolDefaults(s.tool_defaults);
      showNotice(`${TOOL_LABEL[kind]} 기본값을 설정 파일에 저장했습니다`);
    } catch (e) {
      showNotice(`설정 저장 실패: ${errText(e)}`);
    }
  }

  const failedBanner = alignFailedHidden ? `정렬 실패 – 이 페이지의 차이 ${pg?.change_count}개는 실제 도면 변경으로 볼 수 없습니다 (변경 알림 숨김). 오른쪽 검토 패널에서 '그래도 보기'를 누를 수 있습니다.` : "";
  const commonViewer = {
    imgW, imgH, dpi: cmp?.settings.dpi ?? 200, view, onView, fitSignal, selectedNo: selected && selected.baseline_page === page ? selected.detection.region_no : null,
    onBubble: openCardForRegion, onRegionMenu: openRegionMenu, tool, setTool, toolStyle, sel, setSel, onMarkups, boxZoom, magnifier, onMagClick, onNotice: showNotice, onCursor: setCursor,
  };
  const img = (layer: "old" | "old_aligned" | "new" | "overlay") => (cmp ? pageImageUrl(cmp.id, page, layer, scale, layer === "overlay" ? colors : undefined) : null);
  const cardRect = card && cmp && card.page === page && !(mode === "old" && !side) ? cardRegionPx(card, cmp.settings.dpi, cardPane[0], cardPane[1]) : null;
  const zoomCenter = (f: number) => view && setView(zoomAt(view, host[0] / 2, host[1] / 2, f));

  const DropCard = ({ which }: { which: "old" | "new" }) => {
    const d = files[which];
    return (
      <div className="cursor-pointer px-2.5 py-2" onClick={() => pick(which)}
        onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDropHi(false); if (e.dataTransfer.files[0]) void loadPdf(which, e.dataTransfer.files[0]); }}
        style={{ background: d ? "var(--loaded)" : "var(--card)", border: `${dropHi ? 2 : 1}px solid ${dropHi ? "var(--blue)" : d ? "var(--edge-loaded)" : "var(--border)"}` }}>
        <div className="sec">{which === "old" ? "OLD REVISION (PDF)" : "NEW REVISION (PDF)"}</div>
        <div className="break-all" style={{ color: d ? "var(--fg)" : "var(--body)" }}>{d ? <>{d.original_name}<br />{d.page_count} pages</> : "클릭하거나 PDF를 끌어다 놓으세요"}</div>
      </div>
    );
  };

  return (
    <div className="flex h-screen w-screen" onDragOver={(e) => { e.preventDefault(); if (!dropHi) { setDropHi(true); setMenuOpen(true); } }} onDragLeave={(e) => { if (e.relatedTarget === null) setDropHi(false); }} onDrop={onWindowDrop}>
      {/* ============================== 왼쪽 슬라이드 메뉴 (Push) */}
      <div className="relative h-full shrink-0 overflow-hidden" style={{ width: isOpen ? menuWidth : 0, transition: rs.current ? "none" : "width 200ms cubic-bezier(.65,0,.35,1)", background: "var(--panel)" }}>
        <div className="flex h-full flex-col" style={{ width: menuWidth }}>
          <div className="flex items-start px-3.5 pb-1.5 pt-3">
            <div className="flex-1 text-[18px] font-extrabold leading-tight" style={{ color: "var(--title)" }}>DRAWING AUTO<br />COMPARISON</div>
            <button type="button" title={`핀 고정: 메뉴를 왼쪽에 도킹합니다 (창 폭 ${MENU_PIN_MIN_WINDOW}px 이상)`} className="px-1.5" style={{ background: menuPinned ? "var(--blue)" : "transparent" }}
              onClick={() => {
                if (!menuPinned && window.innerWidth < MENU_PIN_MIN_WINDOW) return showNotice(`창 폭이 ${MENU_PIN_MIN_WINDOW}px 미만이라 메뉴를 고정할 수 없습니다`);
                const on = !menuPinned;
                setMenuPinned(on);
                setMenuOpen(true);
                void persist({ menu_pinned: on });
              }}>📌</button>
            <button type="button" title="메뉴 닫기 (Esc)" className="px-1.5" onClick={() => { if (menuPinned) { setMenuPinned(false); void persist({ menu_pinned: false }); } setMenuOpen(false); }}>✕</button>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
            <DropCard which="old" />
            <DropCard which="new" />
            <button type="button" className="bigbtn" style={{ background: "var(--blue)" }} disabled={busy} onClick={() => void startCompare()}>▶&nbsp; START PDF COMPARISON</button>
            <button type="button" className="bigbtn" style={{ background: "var(--orange)" }} onClick={() => (cmp ? (setSide(true), setSel(-1)) : window.alert("안내\n\nPDF 비교를 먼저 실행하세요."))}>SEE OLD &amp; NEW REVISIONS</button>
            <div>
              <button type="button" className="bigbtn" style={{ background: "var(--green)" }} onClick={() => void saveResult()}>SAVE RESULT AS PDF</button>
              <div className="px-0.5 pt-0.5 text-xs" style={{ color: "var(--hint)" }}>{saveTarget}</div>
            </div>
            <label className="flex items-center gap-1.5" style={{ color: "var(--body)", opacity: ai?.available ? 1 : 0.5 }}>
              <input type="checkbox" disabled={!ai?.available} checked={Boolean(settings?.ai_enabled)} onChange={(e) => void persist({ ai_enabled: e.target.checked }).then(() => api.aiStatus().then(setAi))} />
              AI 사용 (Claude API)
            </label>
            <div className="flex gap-1.5">
              <button type="button" className="bigbtn flex-1" style={{ background: ai?.available && settings?.ai_enabled ? "var(--purple)" : "var(--card)", color: ai?.available && settings?.ai_enabled ? "#fff" : "var(--fg2)", whiteSpace: "nowrap" }}
  disabled={!(ai?.available && settings?.ai_enabled)} title="변경 영역을 Claude가 실제 변경 / 오검출 의심으로 분류합니다. 실행 전에 비용을 확인합니다." onClick={() => void startAi()}>🤖&nbsp; AI 검증</button>
<button type="button" className="bigbtn" style={{ background: "var(--card)", color: "var(--fg)", width: "auto", flex: "0 0 auto", padding: "8px 14px", whiteSpace: "nowrap" }} disabled={!ai?.available} onClick={() => setKeyDlg(true)}>AI 키</button>
            </div>

            <div className="box">
              <span className="legend sec">비교 설정</span>
              <label className="flex items-center gap-1.5" style={{ color: "var(--body)" }}>
                <input type="checkbox" disabled={!settings?.opencv_available} checked={autoAlign} onChange={(e) => { setAutoAlign(e.target.checked); void persist({ auto_align: e.target.checked }); }} /> 자동 정렬 (ORB)
              </label>
              <label className="mt-1.5 flex items-center gap-2" style={{ color: "var(--body)" }}>DPI
                <select className="inp" value={dpi} onChange={(e) => { const v = Number(e.target.value); setDpi(v); void persist({ dpi: v }); }}>
                  {(settings?.dpi_choices ?? [150, 200, 288, 400]).map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
              <label className="mt-1.5 flex items-center gap-2" style={{ color: "var(--body)" }} title={"Old·New 선이 이 거리 안에서 겹치면 같은 선으로 봅니다.\n0mm = 픽셀이 정확히 같아야 같은 선. 바꾸면 다시 비교해야 적용됩니다."}>위치 허용 오차
                <select className="inp" value={tolMm} onChange={(e) => { const v = Number(e.target.value); setTolMm(v); void persist({ tol_mm: v }); if (cmp && cmp.settings.tol_mm !== v) showNotice(`위치 허용 오차 ${v} mm – 다시 비교하면 적용됩니다`); }}>
                  {(settings?.tol_mm_choices ?? [0, 0.13, 0.25, 0.5]).map((t) => <option key={t} value={t}>{tolLabel(t)}</option>)}
                </select>
              </label>
            </div>
            <div className="box">
              <span className="legend sec">COLOR LEGEND</span>
              {(["old", "new", "changed"] as const).map((kk) => (
                <div key={kk} className="flex items-center gap-2 py-0.5" style={{ color: "var(--body)" }}>
                  <span className="inline-block h-4 w-6" style={{ background: colors[kk] }} />{kk === "old" ? "Old (removed)" : kk === "new" ? "New (base)" : "Changed (added)"}
                </div>
              ))}
            </div>
            <div className="box space-y-1">
              <span className="legend sec">COLOR SETTING</span>
              {(["old", "new", "changed"] as const).map((kk) => (
                <label key={kk} className="flex items-center" style={{ color: "var(--body)" }}>
                  <span className="w-32">{kk === "old" ? "Old (removed)" : kk === "new" ? "New (base)" : "Changed (added)"}</span>
                  <select className="inp" value={csel[kk].toUpperCase()} onChange={(e) => setCsel({ ...csel, [kk]: e.target.value })}>
                    {!Object.values(settings?.color_choices ?? {}).some((v) => v.toUpperCase() === csel[kk].toUpperCase()) && <option value={csel[kk].toUpperCase()}>{colorName(csel[kk])}</option>}
                    {Object.entries(settings?.color_choices ?? {}).map(([n, h]) => <option key={h} value={h.toUpperCase()}>{n}</option>)}
                  </select>
                </label>
              ))}
              <button type="button" className="bigbtn" style={{ background: "var(--purple)", padding: 5 }} onClick={() => { setColors(csel); void persist({ colors: csel }); }}>Apply</button>
            </div>
            <div className="box">
              <span className="legend sec">DISPLAY</span>
              <div className="flex items-center gap-3" style={{ color: "var(--body)" }}>화면 모드
                {(["dark", "light"] as const).map((t) => (
                  <label key={t} className="flex items-center gap-1">
                    <input type="radio" name="theme" checked={theme === t} onChange={() => { setTheme(t); document.documentElement.dataset.theme = t; window.localStorage.setItem("dac.theme", t); }} />
                    {t === "dark" ? "다크" : "라이트"}
                  </label>
                ))}
              </div>
            </div>
            <div className="box">
              <span className="legend sec">STATUS</span>
              <div style={{ color: statusErr ? "var(--red)" : "var(--body)" }} className="whitespace-pre-wrap break-words">{status}</div>
              <div className="my-1 h-2 w-full" style={{ background: "var(--card)" }}><div className="h-full" style={{ width: `${progress}%`, background: "var(--blue)" }} /></div>
              {cmp && <div style={{ color: "var(--body)" }}>New 마크업: {nMarkups}개{saveState ? ` (${saveState})` : ""}</div>}
              <div className="mt-1 whitespace-pre-line text-xs" style={{ color: "var(--hint)" }}>
                {`opencv-python: ${settings?.opencv_available ? "사용" : "미설치 – 자동 정렬 비활성"}\n드래그앤드롭: 브라우저 기본 지원\nanthropic·keyring: ${ai?.available ? "사용" : "미설치 – AI 검증 비활성"}\n설정 파일: ${settings?.settings_file ?? "-"} (${settings?.settings_file_exists ? "사용" : "없음 – 기본값, 변경 시 생성"})`}
              </div>
            </div>
          </div>
        </div>
        <div className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize" style={{ boxShadow: "inset -3px 0 3px var(--shadow)" }} title={`끌어서 메뉴 폭 조절 (${range[0]}~${range[1]}px)`}
          onPointerDown={onRsDown} onPointerMove={onRsMove} onPointerUp={onRsUp} />
      </div>

      {/* ============================== 오른쪽: 툴바 + 뷰어 */}
      <div className="flex min-w-0 flex-1 flex-col" style={{ background: "var(--bg)" }} onPointerDown={() => { if (menuOpen && !menuPinned && !tool) setMenuOpen(false); }}>
        {/* 1) 페이지·화면 크기 줄 */}
        <div className="flex items-center gap-1 px-1.5 pb-0.5 pt-1.5">
          <button type="button" className={`tbtn h-8 w-9 ${isOpen ? "on" : ""}`} title="메뉴 열기/닫기 (Ctrl+B, 닫기: Esc)" onPointerDown={(e) => e.stopPropagation()} onClick={() => (menuPinned ? undefined : setMenuOpen(!menuOpen))}>☰</button>
          <span className="w-1.5" />
          <button type="button" className="tbtn" onClick={() => gotoPage(page - 1)}>◀</button>
          <span className="w-24 text-center">{cmp ? `Page ${page + 1} / ${cmp.pages.length}` : "Page - / -"}</span>
          <button type="button" className="tbtn" onClick={() => gotoPage(page + 1)}>▶</button>
          <button type="button" className="tbtn ml-2.5" onClick={() => zoomCenter(1 / 1.25)}>−</button>
          <button type="button" className="tbtn" onClick={() => zoomCenter(1.25)}>+</button>
          <button type="button" className="tbtn" onClick={() => setFitSignal((s) => s + 1)}>Fit</button>
          <button type="button" className={`tbtn ${boxZoom ? "on" : ""}`} title="켠 뒤 화면에서 드래그한 사각형 영역을 확대합니다" onClick={() => { setBoxZoom(!boxZoom); setMagnifier(false); setToolState(null); }}>Box Zoom</button>
          <button type="button" className="tbtn ml-3" style={magnifier ? { background: "var(--orange)", color: "#fff" } : undefined}
            title="버튼을 켠 뒤 도면을 클릭하면 클릭한 위치의 Old/New를 나란히 확대한 비교 카드가 열립니다."
            onClick={() => { if (!cmp && !magnifier) return showNotice("PDF 비교를 먼저 실행하세요"); setMagnifier(!magnifier); setBoxZoom(false); setToolState(null); if (!magnifier) showNotice("비교 돋보기: 도면에서 확인할 위치를 클릭하세요 (드래그는 화면 이동)"); }}>비교 돋보기</button>
          <label className="ml-2 flex items-center gap-1" title="변경된 위치 옆 여백에 번호 버블을 표시합니다. 버블을 클릭하면 비교 돋보기가 열립니다."><input type="checkbox" checked={showBubbles} onChange={(e) => setShowBubbles(e.target.checked)} />변경 알림 (숫자)</label>
          <label className="flex items-center gap-1" title="변경된 부분을 테두리 박스로 표시합니다. NEW·OVERLAY 화면과 비교 돋보기에 표시됩니다."><input type="checkbox" checked={showDiffBox} onChange={(e) => setShowDiffBox(e.target.checked)} />변경 알림 (박스)</label>
          <div className="relative ml-auto flex items-center gap-1.5">
            <span className="max-w-[340px] truncate" style={{ color: statusErr ? "var(--red)" : "var(--toolbar)" }} title={status}>{status}</span>
            <div className="h-2.5 w-[120px]" style={{ background: "var(--card)", border: "1px solid var(--border)" }}><div className="h-full" style={{ width: `${progress}%`, background: "var(--blue)" }} /></div>
            {aiNote && <div className="absolute right-0 top-6 z-40 max-w-[460px] whitespace-pre-wrap p-1.5 text-xs" style={{ background: "var(--panel)", border: "1px solid var(--purple)" }}>{aiNote}</div>}
          </div>
        </div>
        {/* 2) 화면 모드 줄 */}
        <div className="flex items-center gap-0.5 px-1.5 py-0.5">
          {(["old", "new", "overlay"] as const).map((m) => (
            <button key={m} type="button" className={`tbtn w-24 ${!side && mode === m ? "on" : ""}`} onClick={() => { setSide(false); setMode(m); setSel(-1); }}>{m.toUpperCase()}</button>
          ))}
          <span className="ml-2.5">{cmp ? `현재 화면: ${side ? "OLD / NEW 나란히 보기" : mode.toUpperCase()}` : ""}</span>
          {side && pg && (
            <label className="ml-3 flex items-center gap-1" title={pg.old_aligned.note}>
              <input type="checkbox" disabled={!pg.old_aligned.available} checked={sideAligned && pg.old_aligned.available} onChange={(e) => setSideAligned(e.target.checked)} />OLD 정렬 적용 (웹 추가 기능)
            </label>
          )}
          {pg && <span className="ml-3"><AlignBadge status={pg.alignment.status} /></span>}
          <button type="button" className={`tbtn ml-auto ${reviewOpen ? "on" : ""}`} onClick={() => setReviewOpen(!reviewOpen)}>검토 패널</button>
        </div>
        {/* 3) 마크업 줄 */}
        <div className="flex items-center gap-0.5 px-1.5 py-0.5">
          <span className="sec mr-1.5" title={"마크업을 클릭하면 선택, 드래그하면 이동, 핸들을 드래그하면 크기·형상 조정,\n빈 곳 드래그는 화면 이동, 더블클릭은 텍스트 수정, Delete는 삭제입니다."}>MARKUP</span>
          {TOOLS.map((t) => (
            <button key={t} type="button" title={`${TOOL_LABEL[t]}\n${TOOL_HINT[t]}`} onClick={() => toggleTool(t)}
              style={{ background: tool === t ? "var(--blue)" : "var(--card)", border: "1px solid var(--border)" }}>
              <ToolIcon kind={t} color={tool === t ? "#fff" : "var(--fg)"} />
            </button>
          ))}
          <button type="button" className={`tbtn ml-2.5 ${propsOpen ? "on" : ""}`} onClick={() => setPropsOpen(!propsOpen)}>마크업 속성</button>
          {cmp && <span className="ml-1.5" style={{ color: editOk ? "var(--green)" : "var(--warn)" }}>{editOk ? "편집 가능 (New 기준)" : `편집 불가: ${editWhy}`}</span>}
          {saveState && <span className="ml-2 text-xs" style={{ color: "var(--hint)" }}>{saveState}</span>}
        </div>
        {/* 4) 안내 문구 줄 */}
        <div className="min-h-[18px] px-2 text-xs" style={{ color: failedBanner && !notice ? "var(--red)" : "var(--warn)" }}>{notice || failedBanner}</div>
        {/* 5) 뷰어 + 검토 패널 */}
        <div className="flex min-h-0 flex-1">
          <div className="relative mx-1.5 my-0.5 flex min-h-0 min-w-0 flex-1" style={{ background: "var(--viewbg)" }}>
            {!cmp ? (
              <Viewer {...commonViewer} role="main" src={null} emptyText="" changes={[]} showBoxes={false} bubbles={null} markups={null} editable={false} denyReason={POLICY_REASON.nocompare} cardRect={null} onSize={onHost} />
            ) : side ? (
              <>
                <Viewer {...commonViewer} role="side_old" label={<div className="sec px-1.5 py-0.5 text-white" style={{ background: "var(--old-frame)" }}>OLD · 마크업 작성·편집 불가</div>}
                  src={pg?.old_exists ? img(sideAligned && pg.old_aligned.available ? "old_aligned" : "old") : null} emptyText="OLD 문서에 없는 페이지 (빈 페이지로 비교됨)"
                  changes={[]} showBoxes={false} bubbles={null} markups={null} editable={false} denyReason={POLICY_REASON.side_old} cardRect={null} />
                <div className="w-1" />
                <Viewer {...commonViewer} role="side_new" label={<div className="sec px-1.5 py-0.5 text-white" style={{ background: "var(--blue)" }}>NEW · 마크업 편집 가능</div>}
                  src={pg?.new_exists ? img("new") : null} emptyText="NEW 문서에 없는 페이지 (빈 페이지로 비교됨)" onSize={onHost}
                  changes={visibleChanges} showBoxes={false} bubbles={null} markups={pageMarkups} editable={editOk} denyReason={editWhy} cardRect={cardRect} />
              </>
            ) : (
              <Viewer {...commonViewer} role="main" onSize={onHost}
                src={mode === "old" ? (pg?.old_exists ? img("old") : null) : mode === "new" ? (pg?.new_exists ? img("new") : null) : img("overlay")}
                emptyText={mode === "old" ? "OLD 문서에 없는 페이지 (빈 페이지로 비교됨)" : "NEW 문서에 없는 페이지 (빈 페이지로 비교됨)"}
                changes={alignFailedHidden ? [] : visibleChanges} showBoxes={showDiffBox && mode !== "old" && !alignFailedHidden} bubbles={bubblesOn ? shownBubbles : null}
                markups={mode === "old" ? null : pageMarkups} editable={editOk} denyReason={editWhy} cardRect={cardRect} />
            )}
            {card && cmp && pg && card.page === page && (
              <CompareCard comparisonId={cmp.id} card={card} setCard={setCard} pageCount={cmp.pages.length} dpi={cmp.settings.dpi} showBoxes={showDiffBox}
                oldExists={pg.old_exists} newExists={pg.new_exists} adopted={pg.alignment.engine_adopted} hostW={host[0]} hostH={host[1]}
                onClose={closeCard} onResized={(w, h) => void persist({ compare_card_size: [w, h] })} onPaneSize={onCardPane} />
            )}
            {propsOpen && <PropertyPanel target={propTarget} onApply={applyProp} onSaveDefault={(kk, s) => void saveDefault(kk, s)} onClose={() => setPropsOpen(false)} />}
          </div>
          {reviewOpen && (
            <ReviewPanel cmp={cmp} changes={changes} page={page} selectedId={selectedId} onSelect={goTo} onSaved={(c) => void onSaved(c)}
              reviewer={reviewer} setReviewer={(v) => { setReviewerState(v); window.localStorage.setItem("dac.reviewer", v); }} onCmp={setCmp}
              project={project} projects={projects}
              onProject={(id) => { const p = projects.find((x) => x.id === id); if (p) void loadProjectData(p).catch((e: unknown) => showNotice(errText(e))); }}
              onNewProject={(name) => void api.createProject(name).then(async (p) => { setProjects(await api.listProjects()); await loadProjectData(p); }, (e: unknown) => showNotice(errText(e)))}
              history={history} onOpen={(id) => void openComparison(id).catch((e: unknown) => showNotice(errText(e)))} onExportJson={() => void exportJson()}
              alignFailedHidden={alignFailedHidden} onShowFailed={() => setShowFailed((s) => ({ ...s, [page]: true }))} onClose={() => setReviewOpen(false)}
              onRowMenu={(c, x, y) => { setSelectedId(c.change_id); setCtx({ x, y, change: c }); }} />
          )}
        </div>
        {/* 6) 하단 통계 줄 */}
        <div className="flex gap-4 truncate px-2 pb-1.5 pt-0.5 text-xs">
          <span className="truncate">{stats}</span>
          <span className="ml-auto shrink-0" style={{ color: "var(--hint)" }}>{cursor && cmp ? `커서 ${((cursor[0] / cmp.settings.dpi) * 25.4).toFixed(1)}, ${((cursor[1] / cmp.settings.dpi) * 25.4).toFixed(1)} mm` : ""} · N/P 다음/이전 영역 · 0–4 판정</span>
        </div>
      </div>

      {ctx && (
        <div className="fixed z-50 min-w-[190px] py-1 text-xs shadow-lg" role="menu"
          style={{ left: Math.min(ctx.x, window.innerWidth - 200), top: Math.min(ctx.y, window.innerHeight - 90), background: "var(--panel)", border: "1px solid var(--border)" }}
          onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
          <div className="px-3 py-1 sec">변경 #{ctx.change.detection.region_no}{ctx.change.review.dismissed ? " · 삭제됨" : ""}</div>
          <button type="button" role="menuitem" autoFocus className="block w-full px-3 py-1.5 text-left hover:opacity-80" disabled={locked}
            style={{ color: ctx.change.review.dismissed ? "var(--fg)" : "var(--red)", opacity: locked ? 0.45 : 1 }} onClick={() => void dismissOrRestore(ctx.change)}>
            {ctx.change.review.dismissed ? "↩ 복원" : "🗑 삭제 (변경 없음)"}
          </button>
          {locked && <div className="px-3 pb-1" style={{ color: "var(--fg2)" }}>검토 완료 상태 – 해제 후 가능</div>}
        </div>
      )}
      {keyDlg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,.4)" }}>
          <div className="w-[420px] space-y-2 p-4" style={{ background: "var(--panel)", border: "1px solid var(--border)" }}>
            <div className="font-bold">Claude API 키</div>
            <p style={{ color: "var(--body)" }}>Anthropic API 키를 붙여넣으세요.<br />Windows 자격 증명 관리자에 저장되며, 비워 두면 저장된 키를 지웁니다.</p>
            <input type="password" autoFocus className="inp w-full" value={keyVal} onChange={(e) => setKeyVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void saveKey()} />
            <div className="flex justify-end gap-2">
              <button type="button" className="tbtn" onClick={() => { setKeyDlg(false); setKeyVal(""); }}>취소</button>
              <button type="button" className="tbtn on" onClick={() => void saveKey()}>확인</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
