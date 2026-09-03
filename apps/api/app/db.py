"""Database session handling, shared by the API and the worker.

Tables are created on startup rather than migrated. That is a deliberate choice
for a demo with no data worth keeping — when there is, this is the seam where
Alembic goes, and nothing above it changes.
"""
from __future__ import annotations

import os
from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from .models import Base

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql+psycopg://jumpais:jumpais@db:5432/jumpais"
)

engine = create_engine(DATABASE_URL, pool_pre_ping=True, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def init_db() -> None:
    Base.metadata.create_all(engine)


def get_session() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
