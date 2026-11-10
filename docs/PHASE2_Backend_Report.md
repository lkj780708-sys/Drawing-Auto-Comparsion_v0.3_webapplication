# Drawing Auto Comparison – Phase 2 Backend Separation 보고서

- 범위: Python 비교 엔진 모듈 분리 + FastAPI Adapter + API 테스트
- 결정 반영 (2026-11-09): B6 = **(가) 현행 유지** (PDF 주석도 비교) / 정렬 신호등 기준 승인 / Backend 착수
- 엔진 로직 변경: **없음**

## 1. 검증 결과 요약 [실측]

| 검증 | 결과 |
|---|---|
| 엔진 추출본 vs 원본: AST 135개 정의 동일 | PASS |
| **FastAPI 경유 결과 vs Phase 1 Baseline (원본 프로그램 직접 실행)** – 6케이스 | **6/6 PASS** |
| └ 비교 항목 | 영역 번호·좌표·removed/added px, 픽셀 통계, 정렬 채택 여부·사유, Old/New 마스크 SHA-256 |
| └ 케이스 | R1 P&ID(288dpi/0.5mm), R2 Basin, A1 동일, D 해상도, E3 90°회전, F 다른 도면 (200dpi/0.25mm) |
| 웹 Export Overlay PDF 이미지 vs 원본 프로그램 Overlay PDF 이미지 (R1, 사용자 설정) | 픽셀 완전 일치 |
| API 동작 테스트 (보안·검토·마크업·내보내기·표시·재시작) | 16/16 PASS |
| 실제 uvicorn 서버 비동기 흐름 (202 → 상태 폴링 → 결과) | 정상 |

## 2. 정렬 신호등 결과 (승인 기준 적용) [실측]

| 케이스 | 최종 IoU | 상태 |
|---|---|---|
| R1, R2, A1 | 0.84~1.00 | Alignment Successful |
| D 해상도 차이 | 0.707 | Alignment Review Required |
| E3 페이지 90° 회전 | 0.920 | Alignment Review Required (페이지 크기 다름 규칙) |
| F 다른 도면 | 0.011 | **Alignment Failed** |

엔진 결과는 그대로이고 상태 라벨만 붙입니다.

## 3. 구조

```
drawing-auto-comparison/
├─ legacy/                 원본 3파일 (변경 없음, 비교 기준)
├─ samples/                실제 Sample + 파생 Sample (사내 도면 – 외부 반출 금지)
├─ backend/
│  ├─ engine/legacy_v10.py 원본 1~1850행 줄 단위 복사 (5부 GUI만 제외)
│  ├─ engine/VERSION.json  원본 SHA-256, 버전
│  ├─ app/config.py        환경변수 설정
│  ├─ app/engine_adapter.py 상수 스냅샷, 정렬 신호등, 마크업 점 개수 검사
│  ├─ app/runner.py        BackgroundTasks 비교 실행 + 결과 저장
│  ├─ app/storage.py       UUID 경로, 무손실 PNG 저장
│  ├─ app/db.py            SQLite (표준 라이브러리)
│  ├─ app/schemas.py       Pydantic 모델
│  ├─ app/main.py          API
│  ├─ tests/               회귀(6) + 동작(16) 테스트, baseline JSON
│  └─ run_server.py
└─ docs/
```

## 4. 실행

```bash
cd backend
pip install -r requirements.txt
# 선택: 기존 설정 파일을 기본값으로 사용
set DAC_LEGACY_SETTINGS_JSON=..\legacy\compare_drawings_overlay_settings.json   (Windows)
python run_server.py          # http://127.0.0.1:8000/docs 에서 API 확인
python -m pytest tests -v     # 전체 테스트 (약 1분 30초)
```

| 환경변수 | 기본값 | 의미 |
|---|---|---|
| DAC_DATA_DIR | backend/data | DB·업로드·결과 저장 폴더 |
| DAC_MAX_UPLOAD_MB | 100 | 업로드 크기 제한 |
| DAC_MAX_CONCURRENT | 1 | 동시 비교 수 (A1 288dpi 1건 ≈ 1.7GB) |
| DAC_ALLOWED_ORIGINS | http://localhost:3000 | Next.js 주소 (CORS) |
| DAC_LEGACY_SETTINGS_JSON | 없음 | 기존 설정 파일 경로 (dpi, 허용오차, 색, 마크업 기본 스타일) |

## 5. API

| Method | 경로 | 설명 |
|---|---|---|
| GET | /api/health | 엔진 버전·환경 |
| GET | /api/defaults | 기존 선택지(DPI 4종, 허용오차 4종, 색 6종) + 설정 파일 값 |
| POST / GET | /api/projects | 프로젝트 생성 / 목록 |
| GET | /api/projects/{id} | |
| POST | /api/documents/upload | multipart (project_id, file). 기존 `read_pdf_checked` 검증 |
| GET | /api/documents?project_id= , /api/documents/{id} | |
| POST | /api/comparisons | 202 + 작업 상태. dpi·auto_align·tol_mm·colors 만 받음 |
| GET | /api/comparisons?project_id= | 비교 이력 |
| GET | /api/comparisons/{id} | 설정·임계값·엔진버전·문서 Hash·페이지별 정렬·통계·검토 집계 |
| GET | /api/comparisons/{id}/status | queued / running / succeeded / failed + 단계 + 페이지 진행 |
| PATCH | /api/comparisons/{id} | 검토 완료 / 해제 (완료 시 판정 집계 스냅샷 저장, 판정 잠금) |
| GET | /api/comparisons/{id}/changes?page= | 변경 영역 (detection 과 review 분리) |
| PATCH | /api/changes/{change_id} | status / comment / reviewer 만 허용, 이력 저장 |
| GET | /api/comparisons/{id}/pages/{n}/image?layer=old\|new\|overlay&old=&new=&changed=&scale= | 저장된 결과로만 그림. 색 변경은 저장 마스크로 `make_overlay` 재합성 |
| GET | /api/comparisons/{id}/pages/{n}/region?which=old\|new&x_pt&y_pt&w_px&h_px&mag | 기존 비교 돋보기 (원본 PDF 영역 재렌더, Old 는 정렬 적용) |
| GET / PUT | /api/comparisons/{id}/pages/{n}/markups | 마크업 8종 (기존 `validate_style` 로 검증) |
| POST | /api/comparisons/{id}/export | overlay_pdf / new_pdf / result_json |
| GET | /api/comparisons/{id}/exports , /api/exports/{id}/download | |

### 변경 영역 데이터 모델 대응
| 요청 필드 | 구현 |
|---|---|
| change_id, project_id, baseline/comparison_document, baseline/comparison_page | 그대로 (페이지는 기존 규칙대로 같은 번호끼리) |
| bounding_box | `bounding_box_px` (dpi 기준, 끝 미포함) + `bounding_box_pt` |
| change_type | **만들지 않음** (결정 3: 색으로 인식). removed_px / added_px 는 보존 |
| difference_score | **기존 엔진에 없음 → 만들지 않음** |
| detection_method, threshold_used, alignment_information | detection_method, 비교 단위 `thresholds`, 페이지 단위 `alignment` |
| review_status, reviewer_comment, reviewed_at | `review` 객체 (탐지 `detection` 객체와 분리, 수정 이력 별도 테이블) |
| created_at | 그대로 |

## 6. 보안
- 업로드 파일은 `uploads/{UUID}.pdf` 로만 저장, 원래 파일명은 화면 표시용으로만 DB에 저장(경로 성분·제어문자 제거)
- 확장자(.pdf) + 실제 내용(기존 엔진 검증: %PDF, 열기, 암호, 페이지 수) 둘 다 검사
- 크기 제한은 스트리밍 중 확인, 초과·실패 시 임시 파일 즉시 삭제, 서버 시작 시 tmp 폴더 정리
- 로그에는 ID·페이지 수·크기만 남김 (파일명·내용 없음)
- 외부 AI API·클라우드 저장소 없음, 비밀값 없음

## 7. 결과 재현성·추적성
비교마다 저장: 두 문서 SHA-256, 설정, 실제 사용 임계값(엔진 상수에서 읽음), 엔진 버전 + 원본 SHA-256 + 추출본 SHA-256, Python·PyMuPDF·OpenCV·NumPy 버전, 정렬 행렬·IoU·사유, 마스크 SHA-256, 시작·종료 시각, 판정 이력.
내보내기 시 저장 마스크의 SHA-256 을 다시 확인하고 다르면 거부합니다.

## 8. 성능 (실제 uvicorn 서버, P&ID 288dpi/0.5mm) [실측]
| 항목 | 값 |
|---|---|
| POST 응답 | 0.02초 (비동기) |
| 엔진 비교 | 5.4초 |
| 결과 이미지 저장 (old/new/overlay/마스크 PNG) | 3.1초 (**신규 비용**) |
| 전체 | 8.8초 |
| Overlay 이미지 첫 요청 / 캐시 | 1.0초 / 0.4초 (712KB) |
| 서버 Peak RSS | 577MB |

## 9. 개발 중 발견해 고친 문제 (Adapter 코드, 엔진 아님)
- **마스크 PNG 복원 시 바이트 불일치**: Pillow 의 1비트 PNG 를 bool 배열로 읽으면 True 가 0x01 이 아니라 0xFF 로 들어와, 값은 같아도 SHA-256 이 달랐습니다. 이 상태로 `~mask` 를 쓰면 결과가 달라질 위험이 있어 0/1 로 정규화했습니다. 내보내기 직전 SHA-256 검사가 이 문제를 잡았습니다.

## 10. 알려진 한계 / 미검증
- **B6 현행 유지**: PDF 주석(Comment·구름·도장)도 도면 변경으로 검출됩니다. 엔진의 `render_pdf` 설명("마크업은 합성하지 않음")과 실제 동작이 다른 점은 그대로 남아 있습니다.
- 서버를 재시작하면 진행 중이던 비교는 "실패"로 기록되고 다시 실행해야 합니다.
- A1 크기 도면을 400dpi 로 비교하는 경우는 측정하지 않았습니다(메모리 위험) – **미검증**
- 대형 도면 전체 이미지(예: 9536×6736)를 브라우저에서 한 장으로 띄우는 성능은 Phase 3 에서 확인 필요. `scale` 파라미터로 축소본 제공 가능
- New PDF 내보내기 파일명 `{New}_markup.pdf` 는 **[제안]** (기존 프로그램은 사용자가 직접 입력)
- 검토 완료는 미검토 항목이 남아 있어도 허용하고 그 시점 집계를 저장합니다 – 업무 규칙 **확인 필요**
- 사용자 인증 없음 (reviewer 이름은 입력값) – 운영 환경 결정 후 검토 필요
- Windows 환경 실행은 **미검증** (분석 서버는 Linux)
