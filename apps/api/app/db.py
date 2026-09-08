"""Database session handling, shared by the API and the worker.

Tables are created on startup rather than migrated. That is a deliberate choice
for a demo with no data worth keeping — when there is, this is the seam where
Alembic goes, and nothing above it changes.
"""
from __future__ import annotations

import os
from collections.abc import Iterator

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from .models import Base

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql+psycopg://jumpais:jumpais@db:5432/jumpais"
)

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    future=True,
    # Unset, SQLAlchemy defaults to pool_size=5 / max_overflow=10 = 15
    # connections, PER PROCESS — this module is imported separately by the
    # api and the worker, each getting its own engine/pool. 15 is fewer than
    # either process can have concurrent DB-holding threads once
    # WORKER_CONCURRENCY / the anyio threadpool are sized for real
    # concurrency (see worker.py and main.py's _startup), so both would
    # silently queue in the pool well before hitting any other limit.
    # docker-compose.yml sets these per-service since the api and worker
    # want different numbers for the same reason they have different
    # concurrency models — see that file's comments for the arithmetic.
    pool_size=int(os.environ.get("DB_POOL_SIZE", "20")),
    max_overflow=int(os.environ.get("DB_MAX_OVERFLOW", "10")),
    # A request/job that can't get a connection within this should fail fast
    # rather than pile up behind whatever is holding the pool — every query
    # this app runs is single-digit milliseconds, so actually hitting this
    # means real exhaustion, not a slow query.
    pool_timeout=float(os.environ.get("DB_POOL_TIMEOUT", "10")),
    # Recycle before a NAT/load-balancer idle-drop kills a pooled connection
    # silently. pool_pre_ping already catches a dead connection, but at the
    # cost of a round trip on every checkout; recycling makes that rarer.
    pool_recycle=int(os.environ.get("DB_POOL_RECYCLE", "1800")),
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def _add_missing_columns() -> None:
    """The one, narrow exception to "tables are created on startup, not
    migrated" (see the module docstring). `create_all()` only ever creates
    MISSING tables — it never alters one that already exists, so a column
    added to models.py after a database has been created needs something
    else to reach it. This is that something else, and it must stay exactly
    this narrow: one `ADD COLUMN IF NOT EXISTS` per column, always nullable,
    never a type change, a NOT NULL, a rename, or a backfill. The moment any
    of those is needed, this function is the wrong tool — introduce Alembic
    instead of teaching this one more trick, the same judgment call this
    file's own docstring already makes about when that seam gets built.

    Safe to call from both processes that call init_db() (the api and the
    worker) on every startup: IF NOT EXISTS makes it idempotent, and two
    processes racing it is no worse than they already race create_all() —
    Postgres serialises the DDL, the loser's statement is a no-op."""
    with engine.begin() as conn:
        conn.execute(text(
            "ALTER TABLE problem ADD COLUMN IF NOT EXISTS generated_from "
            "VARCHAR(32) REFERENCES problem(id) ON DELETE SET NULL"
        ))


def _add_missing_indexes() -> None:
    """Sibling to _add_missing_columns() above, same narrowness contract: one
    CREATE INDEX IF NOT EXISTS per index, never a DROP, never a REINDEX. It
    exists for the same reason that one does — create_all(checkfirst=True)
    skips a table that already exists ENTIRELY, so an index added to
    models.py's Job class never reaches a database that predates it.

    Both indexes back a query that runs on every job the worker claims or
    the api checks:
    - (state, created_at): apps/worker/worker.py's claim_one(), every 2s
      forever, and every generation-quota check below.
    - (requested_by, kind, state): the per-user in-flight count enforced by
      main.py's _enforce_generate_quota(), now checked on every
      generation-class write instead of just POST /problems/{id}/similar.

    Both were fine as sequential scans at demo scale, where `job` stays tiny;
    neither is once it grows one row per generation forever at real traffic.
    Non-CONCURRENTLY on purpose — this takes an ACCESS EXCLUSIVE lock on
    `job` for however many milliseconds that takes at whatever the table's
    current size is, at startup, before traffic exists to block."""
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_job_state_created ON job (state, created_at)"
        ))
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_job_requester_kind_state ON job (requested_by, kind, state)"
        ))


def init_db() -> None:
    Base.metadata.create_all(engine)
    _add_missing_columns()
    _add_missing_indexes()


def get_session() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
