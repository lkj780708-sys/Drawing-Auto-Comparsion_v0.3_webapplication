"""창 1개 실행: 빌드된 화면(frontend/out)과 API 를 한 서버에서 제공하고 브라우저를 연다.
사용: python run_app.py   (또는 프로젝트 폴더의 DrawingAutoComparison.bat 더블클릭)"""
from __future__ import annotations

import logging
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

HOST = os.environ.get("DAC_HOST", "127.0.0.1")
PORT = int(os.environ.get("DAC_PORT", "8000"))
ROOT = Path(__file__).resolve().parents[1]


def _port_busy() -> bool:
    with socket.socket() as s:
        return s.connect_ex((HOST, PORT)) == 0


def _open_when_ready(url: str) -> None:
    for _ in range(120):
        try:
            with urllib.request.urlopen(url + "api/health", timeout=1) as r:
                if r.status == 200:
                    webbrowser.open(url)
                    return
        except Exception:
            time.sleep(0.5)
    print("서버가 60초 안에 준비되지 않았습니다. 위의 오류 메시지를 확인하세요.")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    url = f"http://{HOST}:{PORT}/"
    if not (ROOT / "frontend" / "out" / "index.html").is_file():
        print("화면 빌드 파일(frontend/out)이 없습니다. 처음 한 번 아래를 실행하세요:\n"
              "  cd frontend\n  npm install\n  npm run build")
        return 1
    if _port_busy():
        print(f"{PORT} 포트를 이미 사용 중입니다. 이미 실행 중이면 브라우저에서 {url} 를 여세요.")
        webbrowser.open(url)
        return 0
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import uvicorn
    threading.Thread(target=_open_when_ready, args=(url,), daemon=True).start()
    print(f"Drawing Auto Comparison 실행 중: {url}   (끝내려면 이 창을 닫거나 Ctrl+C)")
    uvicorn.run("app.main:app", host=HOST, port=PORT, workers=1, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
