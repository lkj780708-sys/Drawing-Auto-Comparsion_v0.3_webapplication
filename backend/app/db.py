"""SQLite 저장소 (표준 라이브러리 sqlite3, 외부 DB 없음)."""
from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  original_name TEXT NOT NULL, stored_name TEXT NOT NULL, sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL, page_count INTEGER NOT NULL, page_sizes_json TEXT NOT NULL,
  origin_hint TEXT NOT NULL, uploaded_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS comparisons(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  baseline_doc_id TEXT NOT NULL REFERENCES documents(id),
  comparison_doc_id TEXT NOT NULL REFERENCES documents(id),
  settings_json TEXT NOT NULL, state TEXT NOT NULL, stage TEXT NOT NULL,
  page_done INTEGER NOT NULL DEFAULT 0, page_total INTEGER NOT NULL DEFAULT 0, error TEXT,
  result_json TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  review_completed_at TEXT, review_completed_by TEXT, review_snapshot_json TEXT);
CREATE TABLE IF NOT EXISTS changes(
  id TEXT PRIMARY KEY, comparison_id TEXT NOT NULL REFERENCES comparisons(id),
  page_index INTEGER NOT NULL, region_no INTEGER NOT NULL,
  x0 INTEGER NOT NULL, y0 INTEGER NOT NULL, x1 INTEGER NOT NULL, y1 INTEGER NOT NULL,
  removed INTEGER NOT NULL, added INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_changes_cmp ON changes(comparison_id, page_index, region_no);
CREATE TABLE IF NOT EXISTS reviews(
  change_id TEXT PRIMARY KEY REFERENCES changes(id),
  status TEXT NOT NULL, comment TEXT, reviewer TEXT, reviewed_at TEXT);
CREATE TABLE IF NOT EXISTS review_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT, change_id TEXT NOT NULL, status TEXT NOT NULL,
  comment TEXT, reviewer TEXT, changed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS markups(
  comparison_id TEXT NOT NULL REFERENCES comparisons(id), page_index INTEGER NOT NULL,
  markups_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(comparison_id, page_index));
CREATE TABLE IF NOT EXISTS exports(
  id TEXT PRIMARY KEY, comparison_id TEXT NOT NULL REFERENCES comparisons(id), kind TEXT NOT NULL,
  stored_name TEXT NOT NULL, file_name TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL, verification_json TEXT);
CREATE TABLE IF NOT EXISTS ai_results(
  change_id TEXT PRIMARY KEY REFERENCES changes(id), result TEXT NOT NULL, summary TEXT NOT NULL,
  model TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_runs(
  id TEXT PRIMARY KEY, comparison_id TEXT NOT NULL REFERENCES comparisons(id), state TEXT NOT NULL,
  model TEXT NOT NULL, n_regions INTEGER NOT NULL, n_jobs INTEGER NOT NULL, input_tokens INTEGER NOT NULL,
  est_cost_usd REAL NOT NULL, jobs_done INTEGER NOT NULL DEFAULT 0, results INTEGER NOT NULL DEFAULT 0,
  error TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
"""


# v0.4.1: 사용자 삭제(변경 없음) 표시. 기존 DB 에는 컬럼만 추가하고 기존 기록은 그대로 둔다.
MIGRATIONS = (
    ("reviews", "dismissed_at", "TEXT"),
    ("reviews", "dismissed_by", "TEXT"),
    ("reviews", "dismissed_prev_status", "TEXT"),
    ("review_history", "action", "TEXT NOT NULL DEFAULT 'review'"),
)


def _migrate(c: sqlite3.Connection) -> None:
    for table, col, decl in MIGRATIONS:
        cols = {r[1] for r in c.execute(f"PRAGMA table_info({table})").fetchall()}
        if col not in cols:
            c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.tx() as c:
            c.executescript(SCHEMA)
            _migrate(c)

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            conn = sqlite3.connect(self.path, timeout=30)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys=ON")
            try:
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()

    def one(self, sql: str, args: tuple[Any, ...] = ()) -> sqlite3.Row | None:
        with self.tx() as c:
            return c.execute(sql, args).fetchone()

    def all(self, sql: str, args: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        with self.tx() as c:
            return c.execute(sql, args).fetchall()

    def run(self, sql: str, args: tuple[Any, ...] = ()) -> None:
        with self.tx() as c:
            c.execute(sql, args)


def dumps(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False)
