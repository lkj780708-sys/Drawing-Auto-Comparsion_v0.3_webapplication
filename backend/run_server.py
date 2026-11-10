"""개발용 API 서버만 실행 (화면은 frontend 에서 npm run dev): python run_server.py"""
import logging
import os

import uvicorn

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    uvicorn.run("app.main:app", host=os.environ.get("DAC_HOST", "127.0.0.1"),
                port=int(os.environ.get("DAC_PORT", "8000")), workers=1)
