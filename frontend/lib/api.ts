// FastAPI 호출 래퍼. 오류를 숨기지 않고 ApiError 로 올린다 (빈 결과로 대체하지 않음).
import type {
  AiRun, AiStatus, AppSettings, Bubble, BBox, Change, Colors, Comparison, DocumentInfo, ExportInfo, ExportKind,
  HistoryItem, ImageLayer, JobStatus, Markup, Project, ReviewStatus,
} from "./types";

/** 창 1개 실행(빌드)에서는 같은 서버 → 빈 값. 개발 모드에서만 .env.local 로 지정 */
export const API_BASE: string = (process.env.NEXT_PUBLIC_API_BASE ?? "").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly detail: string) {
    super(detail);
    this.name = "ApiError";
  }
}

function detailToText(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail))
    return detail
      .map((d) => {
        if (typeof d === "string") return d;
        if (d && typeof d === "object" && "msg" in d) {
          const o = d as { msg: unknown; loc?: unknown };
          const loc = Array.isArray(o.loc) ? o.loc.filter((x) => x !== "body").join(".") : "";
          return loc ? `${loc}: ${String(o.msg)}` : String(o.msg);
        }
        return JSON.stringify(d);
      })
      .join("\n");
  return JSON.stringify(detail);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { cache: "no-store", ...init });
  } catch (e) {
    throw new ApiError(0, `서버에 연결할 수 없습니다. 프로그램 창(서버)이 켜져 있는지 확인하세요. (${String(e)})`);
  }
  if (!res.ok) {
    let text = res.statusText;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object" && "detail" in body) text = detailToText((body as { detail: unknown }).detail);
    } catch {
      /* JSON 이 아닌 오류 응답 */
    }
    throw new ApiError(res.status, text);
  }
  return (await res.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const e = encodeURIComponent;

export type SettingsPatch = Partial<{
  dpi: number;
  auto_align: boolean;
  tol_mm: number;
  colors: Colors;
  tool_defaults: Record<string, unknown>;
  menu_pinned: boolean;
  menu_width: number;
  compare_card_size: [number, number];
  ai_enabled: boolean;
}>;

export const api = {
  settings: () => request<AppSettings>("/api/settings"),
  patchSettings: (body: SettingsPatch) => request<AppSettings>("/api/settings", json("PATCH", body)),

  listProjects: () => request<Project[]>("/api/projects"),
  createProject: (name: string) => request<Project>("/api/projects", json("POST", { name })),

  uploadDocument: (projectId: string, file: File) => {
    const fd = new FormData();
    fd.append("project_id", projectId);
    fd.append("file", file, file.name);
    return request<DocumentInfo>("/api/documents/upload", { method: "POST", body: fd });
  },
  getDocument: (id: string) => request<DocumentInfo>(`/api/documents/${e(id)}`),

  listComparisons: (projectId: string) => request<Comparison[]>(`/api/comparisons?project_id=${e(projectId)}`),
  createComparison: (body: {
    project_id: string;
    baseline_document_id: string;
    comparison_document_id: string;
    dpi: number;
    auto_align: boolean;
    tol_mm: number;
    colors: Colors;
  }) => request<JobStatus>("/api/comparisons", json("POST", body)),
  getComparison: (id: string) => request<Comparison>(`/api/comparisons/${e(id)}`),
  getStatus: (id: string) => request<JobStatus>(`/api/comparisons/${e(id)}/status`),
  setReviewCompleted: (id: string, completed: boolean, reviewer: string | null) =>
    request<Comparison>(`/api/comparisons/${e(id)}`, json("PATCH", { review_completed: completed, reviewer })),

  listChanges: (id: string) => request<Change[]>(`/api/comparisons/${e(id)}/changes`),
  patchChange: (changeId: string, body: { status?: ReviewStatus; comment?: string; reviewer?: string }) =>
    request<Change>(`/api/changes/${e(changeId)}`, json("PATCH", body)),
  /** 오른쪽 클릭 → 삭제 (판정 '변경 없음' + 삭제 표시, 이력: 사용자 삭제) */
  dismissChange: (changeId: string, reviewer: string | null) =>
    request<Change>(`/api/changes/${e(changeId)}/dismiss`, json("POST", { reviewer })),
  restoreChange: (changeId: string, reviewer: string | null) =>
    request<Change>(`/api/changes/${e(changeId)}/restore`, json("POST", { reviewer })),
  changeHistory: (changeId: string) => request<HistoryItem[]>(`/api/changes/${e(changeId)}/history`),

  bubbles: (id: string, page: number, zoom: number) =>
    request<Bubble[]>(`/api/comparisons/${e(id)}/pages/${page}/bubbles?zoom=${zoom.toFixed(5)}`),
  cardRegions: (id: string, page: number, ox: number, oy: number, w: number, h: number, mag: number) =>
    request<{ regions: BBox[]; total: number }>(
      `/api/comparisons/${e(id)}/pages/${page}/card_regions?ox=${ox}&oy=${oy}&w_px=${w}&h_px=${h}&mag=${mag.toFixed(4)}`,
    ),

  getMarkups: (id: string, page: number) => request<{ markups: Markup[] }>(`/api/comparisons/${e(id)}/pages/${page}/markups`),
  putMarkups: (id: string, page: number, markups: Markup[]) =>
    request<{ markups: Markup[] }>(`/api/comparisons/${e(id)}/pages/${page}/markups`, json("PUT", { markups })),

  createExport: (id: string, kind: ExportKind, colors: Colors | null) =>
    request<ExportInfo>(`/api/comparisons/${e(id)}/export`, json("POST", { kind, colors, include_markups: true })),

  aiStatus: () => request<AiStatus>("/api/ai/status"),
  aiSetKey: (key: string) => request<AiStatus>("/api/ai/key", json("POST", { key })),
  aiEstimate: (id: string) => request<AiRun>(`/api/comparisons/${e(id)}/ai/estimate`, { method: "POST" }),
  aiStart: (runId: string) => request<AiRun>(`/api/ai/runs/${e(runId)}/start`, { method: "POST" }),
  aiCancel: (runId: string) => request<AiRun>(`/api/ai/runs/${e(runId)}/cancel`, { method: "POST" }),
  aiRun: (runId: string) => request<AiRun>(`/api/ai/runs/${e(runId)}`),
};

/** 저장된 결과 이미지 (비교 재실행 없음). 색을 바꾸면 서버가 저장 마스크로 엔진 make_overlay 재합성 */
export function pageImageUrl(id: string, page: number, layer: ImageLayer, scale: number, colors?: Colors): string {
  const q = new URLSearchParams({ layer, scale: scale.toFixed(4) });
  if (layer === "overlay" && colors) {
    q.set("old", colors.old);
    q.set("new", colors.new);
    q.set("changed", colors.changed);
  }
  return `${API_BASE}/api/comparisons/${e(id)}/pages/${page}/image?${q.toString()}`;
}

/** 기존 '비교 돋보기': 원본 PDF 영역 재렌더 (ox, oy = card_region_origin) */
export function regionUrl(id: string, page: number, which: "old" | "new", ox: number, oy: number, w: number, h: number, mag: number): string {
  return `${API_BASE}/api/comparisons/${e(id)}/pages/${page}/region?which=${which}&ox=${ox}&oy=${oy}&w_px=${w}&h_px=${h}&mag=${mag.toFixed(4)}`;
}

export const downloadUrl = (relative: string): string => `${API_BASE}${relative}`;
export const errText = (x: unknown): string => (x instanceof Error ? x.message : String(x));
