# Drawing Auto Comparison – Web v0.4

기존 `compare_drawings_overlay_gui5_markup_v10.py`(GitHub 업데이트판, AI 검증 포함)의 비교 엔진을 **로직 변경 없이** 웹으로 옮긴 버전입니다.
화면 배치와 다크 색상은 기존 프로그램과 같고, 라이트 모드를 고를 수 있습니다. 서버 창 1개로 실행합니다.

## 1. 처음 한 번만 (설치)
필요: Python 3.11 이상, Node.js 20 이상 (Node.js 는 화면 빌드에만 필요)

```powershell
cd "<압축 푼 폴더>\backend"
pip install -r requirements.txt
pip install -r requirements-ai.txt        # 선택: AI 검증을 쓸 때만

cd ..\frontend
npx next telemetry disable                 # Next.js 익명 통계 끄기
npm install
npm run build                              # frontend\out 폴더가 생기면 성공
```

기존 설정을 쓰려면 지금 쓰시는 `compare_drawings_overlay_settings.json` 을 **압축 푼 폴더 맨 위**(README.md 옆)에 복사하세요.
없으면 기본값으로 시작하고, 메뉴에서 설정을 바꾸면 그 자리에 새로 만들어집니다 (기존 프로그램과 같은 형식).

## 2. 실행 (매번)
**`DrawingAutoComparison.bat` 더블클릭** → 검은 창 1개가 열리고 브라우저가 자동으로 열립니다.
끝낼 때는 검은 창을 닫으면 됩니다. 바탕화면 아이콘: bat 파일 우클릭 → 바로 가기 만들기.

## 3. 화면
기존 프로그램과 같은 배치입니다.
- 왼쪽 메뉴(☰, Ctrl+B, 📌 고정, 오른쪽 끝을 끌어 폭 조절): OLD/NEW 끌어놓기, START / SEE OLD & NEW / SAVE RESULT, AI 사용·AI 검증·AI 키, 비교 설정, COLOR LEGEND, COLOR SETTING + Apply, **DISPLAY(다크/라이트)**, STATUS
- 위: ◀ ▶ − + Fit · Box Zoom · 비교 돋보기 · 변경 알림(숫자/박스) / OLD·NEW·OVERLAY / MARKUP 8종 + 마크업 속성
- 휠 = 위아래 이동, Ctrl+휠 = 확대 (기존과 같음)
- 웹 추가: 오른쪽 **검토 패널**(판정·Comment·AI 제안·프로젝트·이력·검토 완료·결과 JSON), 마크업 자동 저장

## 4. 테스트
```powershell
cd backend
python -m pytest tests -v
```
- 동작 테스트 13건은 그대로 실행됩니다.
- **기존 결과와 같은지 확인하는 회귀 테스트 6건**은 v0.3 에서 두 가지를 복사해야 실행됩니다 (없으면 skip).
  - `v0.3\samples\*.pdf` → `samples\`
  - `v0.3\backend\tests\baseline\*.json` → `backend\tests\baseline\`
- 엔진이 이전과 같은지 자동 확인:
  `python scripts\compare_engine_versions.py "<v0.3 폴더>\backend\engine\legacy_v10.py"`

## 5. 개발 모드 (화면 코드를 고칠 때만)
```powershell
# 터미널 1
cd backend ; python run_server.py
# 터미널 2
cd frontend ; copy .env.local.example .env.local ; npm run dev     # http://localhost:3000
```

## 6. 설정 (환경변수, 선택)
| 변수 | 기본값 | 의미 |
|---|---|---|
| DAC_SETTINGS_JSON | 폴더 맨 위 compare_drawings_overlay_settings.json | 기존 형식 설정 파일 |
| DAC_DATA_DIR | backend\data | DB·업로드·결과 저장 위치 |
| DAC_PORT | 8000 | 서버 포트 |
| DAC_MAX_UPLOAD_MB | 100 | 업로드 크기 제한 |
| DAC_MAX_CONCURRENT | 1 | 동시 비교 수 (A1 288dpi 1건 ≈ 1.7GB) |
