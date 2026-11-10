// FastAPI Pydantic 모델(backend/app/schemas.py)과 1:1 대응. 값의 의미는 백엔드가 결정한다.

export type ReviewStatus = "Unreviewed" | "Confirmed Change" | "No Change" | "False Positive" | "Needs Review";
export const REVIEW_STATUSES: readonly ReviewStatus[] = ["Unreviewed", "Confirmed Change", "No Change", "False Positive", "Needs Review"];
export type AlignmentStatus = "Alignment Successful" | "Alignment Review Required" | "Alignment Failed";
export type JobState = "queued" | "running" | "succeeded" | "failed";
export type MarkupKind = "textbox" | "callout" | "line" | "arrow" | "rect" | "ellipse" | "polygon" | "cloud";
export const TOOLS: readonly MarkupKind[] = ["textbox", "callout", "line", "arrow", "rect", "ellipse", "polygon", "cloud"];
export type ExportKind = "overlay_pdf" | "new_pdf" | "result_json";
export type ImageLayer = "old" | "old_aligned" | "new" | "overlay";
export type ViewMode = "old" | "new" | "overlay";
export type Pt = [number, number];

export interface Colors { old: string; new: string; changed: string }

export interface MarkupStyle {
  fill: string | null;
  stroke: string;
  width: number;
  text_color: string;
  font: string;
  font_size: number;
}

export interface AppSettings {
  dpi_choices: number[];
  tol_mm_choices: number[];
  color_choices: Record<string, string>;
  dpi: number;
  auto_align: boolean;
  tol_mm: number;
  colors: Colors;
  tool_defaults: Record<MarkupKind, MarkupStyle>;
  menu_pinned: boolean;
  menu_width: number;
  menu_width_range: [number, number];
  compare_card_size: [number, number] | null;
  ai_enabled: boolean;
  settings_file: string;
  settings_file_exists: boolean;
  settings_warnings: string[];
  opencv_available: boolean;
  ai_available: boolean;
  max_upload_mb: number;
}

export interface Project { id: string; name: string; description: string | null; created_at: string; document_count: number; comparison_count: number }

export interface DocumentInfo {
  id: string;
  project_id: string;
  original_name: string;
  sha256: string;
  size_bytes: number;
  page_count: number;
  page_sizes_pt: [number, number][];
  origin_hint: "" | "result" | "image_only";
  uploaded_at: string;
}

export interface JobStatus { id: string; state: JobState; stage: string; page_done: number; page_total: number; error: string | null }

export interface Alignment {
  status: AlignmentStatus;
  engine_adopted: boolean;
  engine_reason: string;
  iou_before: number;
  iou_after: number;
  final_iou: number | null;
  matrix: number[][] | null;
  inverse: number[][] | null;
  notes: string[];
  rule: string;
}

export interface PageInfo {
  page_index: number;
  size_px: [number, number];
  old_exists: boolean;
  new_exists: boolean;
  old_page_size_pt: [number, number] | null;
  new_page_size_pt: [number, number] | null;
  stats: { unchanged: number; removed: number; added: number };
  change_count: number;
  alignment: Alignment;
  mask_sha256: { old: string; new: string };
  old_aligned: { available: boolean; verified: boolean; method: string | null; note: string };
}

export interface DocRef { id: string; original_name: string; sha256: string }

export interface Comparison {
  id: string;
  project_id: string;
  state: JobState;
  stage: string;
  baseline_document: DocRef;
  comparison_document: DocRef;
  settings: { dpi: number; auto_align: boolean; tol_mm: number; colors: Colors };
  thresholds: Record<string, unknown> | null;
  engine: Record<string, unknown> | null;
  overall_alignment_status: AlignmentStatus | null;
  pages: PageInfo[];
  timing_s: Record<string, number> | null;
  review_summary: Record<ReviewStatus, number>;
  review_completed_at: string | null;
  review_completed_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export interface BBox { x0: number; y0: number; x1: number; y1: number }

export interface AiInfo { result: "real" | "noise" | "unsure"; label: string; summary: string; model: string; created_at: string }

export interface Change {
  change_id: string;
  comparison_id: string;
  baseline_page: number;
  detection: {
    region_no: number;
    bounding_box_px: BBox;
    bounding_box_pt: BBox;
    dpi: number;
    removed_px: number;
    added_px: number;
    detection_method: string;
    alignment_status: AlignmentStatus;
  };
  review: {
    status: ReviewStatus;
    comment: string | null;
    reviewer: string | null;
    reviewed_at: string | null;
    /** 오른쪽 클릭으로 삭제함 (판정 = No Change). 자동 탐지 결과는 그대로 보존 */
    dismissed: boolean;
    dismissed_at: string | null;
    dismissed_by: string | null;
  };
  ai: AiInfo | null;
  created_at: string;
}

export interface HistoryItem { action: string; status: ReviewStatus; comment: string | null; reviewer: string | null; changed_at: string; label: string }

export interface Bubble { region_no: number; cx: number; cy: number; clear: boolean }

export interface Markup {
  kind: MarkupKind;
  /** New 페이지 좌표(pt). 엔진 Markup.pts 와 동일 */
  pts: Pt[];
  text: string;
  style: MarkupStyle;
}

export interface ExportInfo {
  id: string;
  kind: ExportKind;
  file_name: string;
  size_bytes: number;
  sha256: string;
  created_at: string;
  verification: { pages?: number; annots?: number } | null;
  download_url: string;
}

export interface AiStatus { available: boolean; enabled: boolean; has_key: boolean; model: string }

export interface AiRun {
  id: string;
  comparison_id: string;
  state: "estimated" | "running" | "succeeded" | "failed" | "cancelled";
  model: string;
  n_regions: number;
  n_jobs: number;
  input_tokens: number;
  est_cost_usd: number;
  jobs_done: number;
  results: number;
  error: string | null;
  confirm_text: string;
}
