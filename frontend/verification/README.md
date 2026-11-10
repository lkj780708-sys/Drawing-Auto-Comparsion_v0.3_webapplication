# 검증 스크립트 (분석 서버 전용)

분석 서버에는 사내 정책으로 `next`, `@types/react` 를 설치할 수 없어서, 아래 방법으로 가능한 범위만 검증했습니다.
실제 사용 PC에서는 `npm install` 후 `npm run typecheck` / `npm run build` 로 다시 확인해야 합니다.

| 파일 | 내용 |
|---|---|
| shims/ | 최소 React/Next 타입 (검증 전용, 앱에서 사용하지 않음) |
| tsconfig.json | 위 타입으로 strict 타입 검사 |
| tsconfig.build.json | TSX → CommonJS 트랜스파일 |
| nextshim/ | Node 에서 `@/`, `next/link`, `next/navigation` 을 풀기 위한 require 훅 |
| geom_parity.js | 화면용 마크업 모양 함수 = 엔진 함수 수치 비교 |
| it_workflow.js | 실제 FastAPI 서버에 lib/api.ts 로 전체 Workflow 실행 |
| ssr_render.js | React 서버 렌더로 컴포넌트가 실제 데이터로 그려지는지 확인 |
