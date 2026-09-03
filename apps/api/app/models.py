"""Tables, following docs/SCHEMA.md.

The shape is deliberately the one the frontend's localStorage stores already
imply — those were written to be replaced by an API, which makes them the honest
statement of what the screens need. Read docs/SCHEMA.md for why a lesson holds
several problems rather than being one, and why the two chats are one table.

Only the parts the demo needs are mapped. chat_session / chat_message are not
here on purpose: conversation transcripts stay in the browser for now, while
lessons and pages — the things a student on another machine has to see — live
in Postgres.
"""
from __future__ import annotations

import datetime as dt
import uuid
from typing import Optional

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _id() -> str:
    return uuid.uuid4().hex


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class User(Base, TimestampMixin):
    """There is no auth (see apps/web/src/lib/session.ts). These rows exist so
    authorship and enrolment point at something, and so adding a real identity
    provider later is a join rather than a migration."""

    __tablename__ = "app_user"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)  # teacher | student


class Classroom(Base, TimestampMixin):
    __tablename__ = "classroom"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    subject: Mapped[Optional[str]] = mapped_column(String(100))
    level: Mapped[Optional[str]] = mapped_column(String(50))
    owner_id: Mapped[Optional[str]] = mapped_column(ForeignKey("app_user.id"))
    archived_at: Mapped[Optional[dt.datetime]] = mapped_column(DateTime(timezone=True))

    lessons: Mapped[list["Lesson"]] = relationship(
        back_populates="classroom", cascade="all, delete-orphan"
    )


class Enrollment(Base, TimestampMixin):
    __tablename__ = "enrollment"
    __table_args__ = (UniqueConstraint("classroom_id", "user_id"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    classroom_id: Mapped[str] = mapped_column(
        ForeignKey("classroom.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[str] = mapped_column(ForeignKey("app_user.id"), nullable=False)


class Lesson(Base, TimestampMixin):
    """บทเรียน. `status` is the confirmation gate: a lesson stays 'draft' —
    invisible to students — until a teacher publishes it. See SCHEMA.md."""

    __tablename__ = "lesson"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    classroom_id: Mapped[str] = mapped_column(
        ForeignKey("classroom.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    chapter: Mapped[Optional[str]] = mapped_column(String(100))
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="draft", nullable=False)
    published_at: Mapped[Optional[dt.datetime]] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[Optional[str]] = mapped_column(ForeignKey("app_user.id"))

    classroom: Mapped["Classroom"] = relationship(back_populates="lessons")
    problems: Mapped[list["Problem"]] = relationship(
        back_populates="lesson", cascade="all, delete-orphan"
    )


class Problem(Base, TimestampMixin):
    """One of the โจทย์ inside a lesson — "1 จาก 4 โจทย์" is position+1 of count.

    `extracted_text` matters more than it looks. When a problem arrives as a
    photo the model reads the image directly, and a misread photo yields a
    flawless page solving the WRONG problem that every automated check passes.
    Storing what the model understood the problem to be, and showing it at
    confirmation time, is the only thing that makes that catchable.
    """

    __tablename__ = "problem"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    lesson_id: Mapped[str] = mapped_column(
        ForeignKey("lesson.id", ondelete="CASCADE"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    source: Mapped[str] = mapped_column(String(16), default="text", nullable=False)
    raw_text: Mapped[Optional[str]] = mapped_column(Text)
    image_path: Mapped[Optional[str]] = mapped_column(String(500))
    extracted_text: Mapped[Optional[str]] = mapped_column(Text)
    level: Mapped[Optional[str]] = mapped_column(String(50))

    lesson: Mapped["Lesson"] = relationship(back_populates="problems")
    pages: Mapped[list["Page"]] = relationship(
        back_populates="problem", cascade="all, delete-orphan"
    )


class Page(Base, TimestampMixin):
    """The generated artefact.

    `kit_version` is load-bearing, not bookkeeping: it is what makes "improve
    the shell, re-execute every past page" possible, and that has already
    repaired pages that were rendering as two stacked frames and taken 3D pages
    from static to animated without regenerating anything. `superseded_by` keeps
    the history so a re-run against a newer kit does not destroy the old one.

    `checks_json` is stored verbatim. Its shape changes whenever a check is
    added, and every consumer reads it as a blob.
    """

    __tablename__ = "page"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    problem_id: Mapped[str] = mapped_column(
        ForeignKey("problem.id", ondelete="CASCADE"), nullable=False
    )
    kit_version: Mapped[Optional[str]] = mapped_column(String(100))
    model: Mapped[Optional[str]] = mapped_column(String(100))
    effort: Mapped[Optional[str]] = mapped_column(String(20))
    html_path: Mapped[Optional[str]] = mapped_column(String(500))
    thumb_path: Mapped[Optional[str]] = mapped_column(String(500))
    path_chosen: Mapped[Optional[str]] = mapped_column(String(16))  # board | svg
    checks_json: Mapped[Optional[dict]] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(16), default="generating", nullable=False)
    superseded_by: Mapped[Optional[str]] = mapped_column(ForeignKey("page.id"))

    problem: Mapped["Problem"] = relationship(back_populates="pages")


class Review(Base, TimestampMixin):
    """seconds_on_page is recorded because rubber-stamping is the silent failure
    of this whole design: if approving is slow, a teacher clicks through without
    reading and every metric stays green."""

    __tablename__ = "review"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    page_id: Mapped[str] = mapped_column(
        ForeignKey("page.id", ondelete="CASCADE"), nullable=False
    )
    reviewer_id: Mapped[Optional[str]] = mapped_column(ForeignKey("app_user.id"))
    action: Mapped[str] = mapped_column(String(16), nullable=False)
    note: Mapped[Optional[str]] = mapped_column(Text)
    seconds_on_page: Mapped[Optional[int]] = mapped_column(Integer)


class Job(Base, TimestampMixin):
    __tablename__ = "job"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)  # generate | recheck
    target_id: Mapped[str] = mapped_column(String(32), nullable=False)
    state: Mapped[str] = mapped_column(String(16), default="queued", nullable=False)
    stage: Mapped[Optional[str]] = mapped_column(String(50))
    progress_json: Mapped[Optional[dict]] = mapped_column(JSON)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error: Mapped[Optional[str]] = mapped_column(Text)
    started_at: Mapped[Optional[dt.datetime]] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[Optional[dt.datetime]] = mapped_column(DateTime(timezone=True))
