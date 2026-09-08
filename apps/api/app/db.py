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

engine = create_engine(DATABASE_URL, pool_pre_ping=True, future=True)
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


def init_db() -> None:
    Base.metadata.create_all(engine)
    _add_missing_columns()


def get_session() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
