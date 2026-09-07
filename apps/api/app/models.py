"""Tables, following docs/SCHEMA.md.

This replaces the classroom/lesson model (archived on `archive/b2b-classroom-poc`)
with a section tree shared by every user, plus real accounts. The shift:

- Classroom, Enrollment, Lesson are gone. A classroom was a subset of users;
  nothing here is a subset of users any more — content is either global
  (every signed-in user can see it once published) or personal (only its
  owner ever can). Two rules, no membership table.
- `Section` is one self-referential tree instead of a fixed two-level
  classroom -> lesson shape, because a real exam book is not always two
  levels deep: a topical past-papers book wants book -> topic -> question,
  a by-year one wants book -> year -> question. A "book" is not a separate
  entity, it is just a root section (`parent_id IS NULL`). Depth is capped in
  the API (see main.py's MAX_SECTION_DEPTH), not here — raising the cap later
  is a constant, not a migration.
- `scope` + `owner_id` appear on both `Section` and `Problem`, with the same
  CHECK constraint on each: global rows have no owner, personal rows always
  do. This is not `owner_id IS NULL` on its own, which is a live footgun — one
  bug nulling a column would silently promote someone's private homework into
  the library every user sees. The CHECK makes that state unrepresentable.
- `Problem.section_id` is nullable on purpose. Photograph a problem, get a
  page — that loop should not require filing it into a section first. An
  unfiled personal problem is a first-class state ("my library"'s inbox), not
  a bug to route around.

`User` now holds a real password and `Session` a real login — see auth.py.
Page, Review and Job are unchanged from the classroom-era schema: a Page still
does not know or care what organises the Problem it belongs to, and the
draft/published two-volume approval mechanism carries over untouched (see
CLAUDE.md's "A page a teacher has not approved is not in the students' path
at all" — now gating a global section instead of a classroom).
"""
from __future__ import annotations

import datetime as dt
import uuid
from typing import Optional

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
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
    """A real account. `role` is `user` or `admin` — admin is who can write to
    the global library (see Section) and is granted only by `ADMIN_EMAILS` at
    startup (see main.py's `_bootstrap_admins`), never through an endpoint."""

    __tablename__ = "app_user"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    email: Mapped[str] = mapped_column(String(320), nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(String(200), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    role: Mapped[str] = mapped_column(String(16), default="user", nullable=False)  # user | admin


class Session(Base, TimestampMixin):
    """A login session. `id` IS the cookie value — an opaque random token, not
    a signed/stateless JWT — so logging out, or an admin revoking a session,
    is one DELETE rather than needing a blocklist. `expires_at` is checked on
    every use; nothing prunes expired rows yet (fine at this scale — see
    docs/BACKLOG.md if that ever needs to change)."""

    __tablename__ = "session"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("app_user.id", ondelete="CASCADE"), nullable=False
    )
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Section(Base, TimestampMixin):
    """A node in the content tree — a book, a topic, a chapter, a year, or a
    user's own folder. `kind` is a free-text display label only ("book" |
    "topic" | "paper" | "year" | ...); the tree itself carries the real
    structure, so it is not an enum with behaviour hung off it.

    `status`/`published_at` are the confirmation gate, and only mean anything
    for `scope='global'` — a personal section has no gate (see Problem) and
    leaves `status` at its unused default. Visibility for global content
    requires every ancestor up to the root to be published, not just the
    section itself: a topic is not visible if its book is not (see
    main.py's `_is_visible`)."""

    __tablename__ = "section"
    __table_args__ = (
        CheckConstraint(
            "(scope = 'global' AND owner_id IS NULL) OR "
            "(scope = 'personal' AND owner_id IS NOT NULL)",
            name="section_scope_owner_consistency",
        ),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    parent_id: Mapped[Optional[str]] = mapped_column(ForeignKey("section.id", ondelete="CASCADE"))
    scope: Mapped[str] = mapped_column(String(16), nullable=False)  # global | personal
    owner_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("app_user.id", ondelete="CASCADE")
    )
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    kind: Mapped[Optional[str]] = mapped_column(String(50))
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    depth: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="draft", nullable=False)
    published_at: Mapped[Optional[dt.datetime]] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[Optional[str]] = mapped_column(
        ForeignKey("app_user.id", ondelete="SET NULL")
    )
    archived_at: Mapped[Optional[dt.datetime]] = mapped_column(DateTime(timezone=True))

    parent: Mapped[Optional["Section"]] = relationship(remote_side=[id], back_populates="children")
    children: Mapped[list["Section"]] = relationship(
        back_populates="parent", cascade="all, delete-orphan"
    )
    problems: Mapped[list["Problem"]] = relationship(back_populates="section")


class Problem(Base, TimestampMixin):
    """One submitted problem — โจทย์ — text or photo-sourced.

    `section_id` is nullable: the core loop is photograph-a-problem,
    get-a-page, and filing it into a section is optional and can happen
    later or never (see the module docstring). Because of that, visibility
    cannot live on the section alone — `scope`/`owner_id` are here too, with
    the same CHECK as `Section`, and an unfiled problem's access rule is just
    "its owner can see it", no tree walk needed.

    `extracted_text` matters more than it looks. When a problem arrives as a
    photo the model reads the image directly, and a misread photo yields a
    flawless page solving the WRONG problem that every automated check
    passes. Storing what the model understood the problem to be — and, for
    personal content with no reviewer, showing it prominently right beside
    the page rather than only at a confirmation step — is the only thing
    that makes that catchable.
    """

    __tablename__ = "problem"
    __table_args__ = (
        CheckConstraint(
            "(scope = 'global' AND owner_id IS NULL) OR "
            "(scope = 'personal' AND owner_id IS NOT NULL)",
            name="problem_scope_owner_consistency",
        ),
    )
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    section_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("section.id", ondelete="SET NULL")
    )
    scope: Mapped[str] = mapped_column(String(16), nullable=False)  # global | personal
    owner_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("app_user.id", ondelete="CASCADE")
    )
    created_by: Mapped[Optional[str]] = mapped_column(
        ForeignKey("app_user.id", ondelete="SET NULL")
    )
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    source: Mapped[str] = mapped_column(String(16), default="text", nullable=False)
    raw_text: Mapped[Optional[str]] = mapped_column(Text)
    image_path: Mapped[Optional[str]] = mapped_column(String(500))
    extracted_text: Mapped[Optional[str]] = mapped_column(Text)
    level: Mapped[Optional[str]] = mapped_column(String(50))

    section: Mapped[Optional["Section"]] = relationship(back_populates="problems")
    pages: Mapped[list["Page"]] = relationship(
        back_populates="problem", cascade="all, delete-orphan"
    )


class Page(Base, TimestampMixin):
    """The generated artefact. Unchanged from the classroom-era schema — see
    archive/b2b-classroom-poc — because nothing about what a page is changed
    in this pivot, only what organises the problem it belongs to.

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
    """The confirmation gate's audit trail — global content only. A personal
    page has no Review row: nobody is protected by making a user approve
    their own page, and a mandatory self-approve button is exactly the
    rubber-stamp failure `seconds_on_page` exists to catch. See
    docs/BACKLOG.md and CLAUDE.md for the full reasoning."""

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
    kind: Mapped[str] = mapped_column(String(20), nullable=False)  # generate | tutor_ask
    target_id: Mapped[str] = mapped_column(String(32), nullable=False)
    state: Mapped[str] = mapped_column(String(16), default="queued", nullable=False)
    stage: Mapped[Optional[str]] = mapped_column(String(50))
    progress_json: Mapped[Optional[dict]] = mapped_column(JSON)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error: Mapped[Optional[str]] = mapped_column(Text)
    started_at: Mapped[Optional[dt.datetime]] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[Optional[dt.datetime]] = mapped_column(DateTime(timezone=True))
