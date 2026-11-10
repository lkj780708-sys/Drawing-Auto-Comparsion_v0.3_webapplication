"""API Request/Response Pydantic 모델."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from engine import legacy_v10 as E

ReviewStatus = Literal["Unreviewed", "Confirmed Change", "No Change", "False Positive", "Needs Review"]
AlignmentStatus = Literal["Alignment Successful", "Alignment Review Required", "Alignment Failed"]
JobState = Literal["queued", "running", "succeeded", "failed"]
MarkupKind = Literal["textbox", "callout", "line", "arrow", "rect", "ellipse", "polygon", "cloud"]
ExportKind = Literal["overlay_pdf", "new_pdf", "result_json"]
AiResult = Literal["real", "noise", "unsure"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _dpi(v: int) -> int:
    if v not in E.DPI_CHOICES:
        raise ValueError(f"dpi 는 {E.DPI_CHOICES} 중 하나여야 합니다")
    return v


def _tol(v: float) -> float:
    for c in E.CHANGE_TOL_CHOICES:
        if abs(v - c) < 1e-9:
            return c
    raise ValueError(f"tol_mm 은 {E.CHANGE_TOL_CHOICES} 중 하나여야 합니다")


# ------------------------------------------------------------------ projects / documents
class ProjectCreate(_Strict):
    name: str = Field(min_length=1, max_length=200)
    description: Optional[str] = Field(default=None, max_length=2000)


class ProjectOut(BaseModel):
    id: str
    name: str
    description: Optional[str]
    created_at: datetime
    document_count: int
    comparison_count: int


class DocumentOut(BaseModel):
    id: str
    project_id: str
    original_name: str
    sha256: str
    size_bytes: int
    page_count: int
    page_sizes_pt: list[tuple[float, float]]
    origin_hint: str = Field(description="'' / 'result'(이 프로그램의 Overlay 결과 PDF) / 'image_only'")
    uploaded_at: datetime


# ------------------------------------------------------------------ settings (기존 설정 파일과 같은 항목)
class Colors(_Strict):
    old: str
    new: str
    changed: str

    @field_validator("old", "new", "changed")
    @classmethod
    def _hex(cls, v: str) -> str:
        return E.parse_hex_color(v)


class SettingsOut(BaseModel):
    dpi_choices: list[int]
    tol_mm_choices: list[float]
    color_choices: dict[str, str]
    dpi: int
    auto_align: bool
    tol_mm: float
    colors: Colors
    tool_defaults: dict[str, dict[str, Any]]
    menu_pinned: bool
    menu_width: int
    menu_width_range: tuple[int, int]
    compare_card_size: Optional[tuple[int, int]]
    ai_enabled: bool
    settings_file: str
    settings_file_exists: bool
    settings_warnings: list[str]
    opencv_available: bool
    ai_available: bool
    max_upload_mb: int
    font_note: str


class SettingsPatch(_Strict):
    """보낸 항목만 바꿔 설정 파일에 저장 (기존 프로그램의 save_settings 사용)."""
    dpi: Optional[int] = None
    auto_align: Optional[bool] = None
    tol_mm: Optional[float] = None
    colors: Optional[Colors] = None
    tool_defaults: Optional[dict[str, dict[str, Any]]] = None
    menu_pinned: Optional[bool] = None
    menu_width: Optional[int] = None
    compare_card_size: Optional[tuple[int, int]] = None
    ai_enabled: Optional[bool] = None

    @field_validator("dpi")
    @classmethod
    def _v_dpi(cls, v: Optional[int]) -> Optional[int]:
        return None if v is None else _dpi(v)

    @field_validator("tol_mm")
    @classmethod
    def _v_tol(cls, v: Optional[float]) -> Optional[float]:
        return None if v is None else _tol(v)


# ------------------------------------------------------------------ comparisons
class ComparisonCreate(_Strict):
    project_id: str
    baseline_document_id: str
    comparison_document_id: str
    dpi: int
    auto_align: bool
    tol_mm: float
    colors: Colors

    @field_validator("dpi")
    @classmethod
    def _v_dpi(cls, v: int) -> int:
        return _dpi(v)

    @field_validator("tol_mm")
    @classmethod
    def _v_tol(cls, v: float) -> float:
        return _tol(v)


class JobStatusOut(BaseModel):
    id: str
    state: JobState
    stage: str
    page_done: int
    page_total: int
    error: Optional[str]


class AlignmentOut(BaseModel):
    status: AlignmentStatus
    engine_adopted: bool
    engine_reason: str
    iou_before: float
    iou_after: float
    final_iou: Optional[float]
    matrix: Optional[list[list[float]]]
    inverse: Optional[list[list[float]]]
    notes: list[str]
    rule: str


class PageOut(BaseModel):
    page_index: int
    size_px: tuple[int, int]
    old_exists: bool
    new_exists: bool
    old_page_size_pt: Optional[tuple[float, float]]
    new_page_size_pt: Optional[tuple[float, float]]
    stats: dict[str, int]
    change_count: int
    alignment: AlignmentOut
    mask_sha256: dict[str, str]
    old_aligned: dict[str, Any]


class DocRef(BaseModel):
    id: str
    original_name: str
    sha256: str


class ComparisonOut(BaseModel):
    id: str
    project_id: str
    state: JobState
    stage: str
    baseline_document: DocRef
    comparison_document: DocRef
    settings: dict[str, Any]
    thresholds: Optional[dict[str, Any]]
    engine: Optional[dict[str, Any]]
    overall_alignment_status: Optional[AlignmentStatus]
    pages: list[PageOut]
    timing_s: Optional[dict[str, float]]
    review_summary: dict[str, int]
    review_completed_at: Optional[datetime]
    review_completed_by: Optional[str]
    created_at: datetime
    started_at: Optional[datetime]
    finished_at: Optional[datetime]
    error: Optional[str]


class ComparisonPatch(_Strict):
    review_completed: bool
    reviewer: Optional[str] = Field(default=None, max_length=100)


# ------------------------------------------------------------------ changes
class BBox(BaseModel):
    x0: float
    y0: float
    x1: float
    y1: float


class DetectionOut(BaseModel):
    """자동 탐지 결과 (변경 불가)."""
    region_no: int
    bounding_box_px: BBox
    bounding_box_pt: BBox
    dpi: int
    removed_px: int
    added_px: int
    detection_method: str
    alignment_status: AlignmentStatus


class ReviewOut(BaseModel):
    """사용자 판정 (탐지 결과와 별도 저장)."""
    status: ReviewStatus
    comment: Optional[str]
    reviewer: Optional[str]
    reviewed_at: Optional[datetime]
    dismissed: bool = Field(description="사용자가 화면에서 삭제함 (판정 = No Change). 자동 탐지 결과는 그대로 보존")
    dismissed_at: Optional[datetime]
    dismissed_by: Optional[str]


class AiOut(BaseModel):
    """AI 제안 (탐지·사용자 판정과 별도 저장, 비교 결과를 바꾸지 않음)."""
    result: AiResult
    label: str
    summary: str
    model: str
    created_at: datetime


class ChangeOut(BaseModel):
    change_id: str
    project_id: str
    comparison_id: str
    baseline_document: str
    comparison_document: str
    baseline_page: int
    comparison_page: int
    detection: DetectionOut
    review: ReviewOut
    ai: Optional[AiOut]
    created_at: datetime


class ChangePatch(_Strict):
    """판정·Comment 만 수정 가능. 탐지 필드는 스키마에 없으므로 보내면 422."""
    status: Optional[ReviewStatus] = None
    comment: Optional[str] = Field(default=None, max_length=4000)
    reviewer: Optional[str] = Field(default=None, max_length=100)


class DismissIn(_Strict):
    """오른쪽 클릭 → 삭제 (변경 없음) / 복원."""
    reviewer: Optional[str] = Field(default=None, max_length=100)


class HistoryOut(BaseModel):
    action: str
    status: ReviewStatus
    comment: Optional[str]
    reviewer: Optional[str]
    changed_at: datetime
    label: str


class BubbleOut(BaseModel):
    region_no: int
    cx: float
    cy: float
    clear: bool


class CardRegionsOut(BaseModel):
    regions: list[BBox]
    total: int


# ------------------------------------------------------------------ markups
class MarkupIn(_Strict):
    kind: MarkupKind
    pts: list[list[float]] = Field(description="New 페이지 좌표(pt). 엔진 Markup.pts 와 동일 좌표계")
    text: str = Field(default="", max_length=4000)
    style: dict[str, Any]

    @field_validator("pts")
    @classmethod
    def _pts(cls, v: list[list[float]]) -> list[list[float]]:
        if len(v) > 500:
            raise ValueError("점이 너무 많습니다 (최대 500)")
        for p in v:
            if len(p) != 2:
                raise ValueError("각 점은 [x, y] 여야 합니다")
        return v


class MarkupsPut(_Strict):
    markups: list[MarkupIn] = Field(max_length=2000)


class MarkupOut(BaseModel):
    kind: MarkupKind
    pts: list[list[float]]
    text: str
    style: dict[str, Any]


class PageMarkupsOut(BaseModel):
    comparison_id: str
    page_index: int
    markups: list[MarkupOut]
    updated_at: Optional[datetime]


# ------------------------------------------------------------------ exports
class ExportCreate(_Strict):
    kind: ExportKind
    colors: Optional[Colors] = None
    include_markups: bool = True


class ExportOut(BaseModel):
    id: str
    comparison_id: str
    kind: ExportKind
    file_name: str
    size_bytes: int
    sha256: str
    created_at: datetime
    verification: Optional[dict[str, Any]]
    download_url: str


# ------------------------------------------------------------------ AI (기존 4-b부 그대로 호출)
class AiStatusOut(BaseModel):
    available: bool
    enabled: bool
    has_key: bool
    model: str


class AiKeyIn(_Strict):
    key: str = Field(max_length=500, description="빈 값이면 저장된 키 삭제")


class AiRunOut(BaseModel):
    id: str
    comparison_id: str
    state: Literal["estimated", "running", "succeeded", "failed", "cancelled"]
    model: str
    n_regions: int
    n_jobs: int
    input_tokens: int
    est_cost_usd: float
    jobs_done: int
    results: int
    error: Optional[str]
    confirm_text: str
    created_at: datetime
