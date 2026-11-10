"""실행 설정. 모든 값은 환경변수로 바꿀 수 있다. (API Key 는 코드·설정 파일에 저장하지 않는다)"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
ROOT_DIR = BACKEND_DIR.parent


def _int_env(name: str, default: int, lo: int, hi: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        v = int(raw)
    except ValueError as e:
        raise RuntimeError(f"환경변수 {name} 는 정수여야 합니다: {raw!r}") from e
    if not lo <= v <= hi:
        raise RuntimeError(f"환경변수 {name} 는 {lo}~{hi} 범위여야 합니다: {v}")
    return v


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    max_upload_mb: int
    max_concurrent_comparisons: int
    allowed_origins: tuple[str, ...]
    settings_json_path: Path          # 기존 프로그램과 같은 형식의 설정 파일 (없으면 기본값, 저장 시 생성)
    static_dir: Path | None           # 빌드된 화면(frontend/out). 있으면 같은 서버에서 제공 (창 1개 실행)

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


def load_settings() -> Settings:
    data_dir = Path(os.environ.get("DAC_DATA_DIR", str(BACKEND_DIR / "data"))).resolve()
    origins = tuple(o.strip() for o in os.environ.get("DAC_ALLOWED_ORIGINS", "http://localhost:3000").split(",")
                    if o.strip())
    sj = os.environ.get("DAC_SETTINGS_JSON") or os.environ.get("DAC_LEGACY_SETTINGS_JSON")
    settings_json = Path(sj).resolve() if sj else (ROOT_DIR / "compare_drawings_overlay_settings.json")
    st = Path(os.environ.get("DAC_STATIC_DIR", str(ROOT_DIR / "frontend" / "out"))).resolve()
    return Settings(
        data_dir=data_dir,
        max_upload_mb=_int_env("DAC_MAX_UPLOAD_MB", 100, 1, 2048),
        # Phase 1 실측: A1 도면 288dpi 비교 1건 Peak RSS ≈ 1.7GB → 기본 1건
        max_concurrent_comparisons=_int_env("DAC_MAX_CONCURRENT", 1, 1, 8),
        allowed_origins=origins,
        settings_json_path=settings_json,
        static_dir=st if (st / "index.html").is_file() else None,
    )
