"""The API.

It never serves page HTML. Pages are written to the shared storage volume and
served by the `pages` origin, so the app can embed them in an opaque-origin
sandboxed iframe. That is the containment for model-written JavaScript, and it
is why `checks_json` is stored and served from here — the app has no way to read
anything out of a page.

It also has no model dependency of its own — google-genai is only installed in
the worker image (apps/worker/Dockerfile), and this file's owned surface does
not include apps/api/Dockerfile. So both model-backed features below hand off
to a worker job and answer synchronously by polling that job's row rather than
calling the model in this process:

- POST /pages/{page_id}/ask  creates a `tutor_ask` job and waits on it
  (see _poll_job below, and apps/worker/worker.py: handle_tutor_ask()).
- POST /problems/image and POST /sections/{id}/problems/image  save the
  upload and queue an ordinary `generate` job; the worker hands the image to
  the model directly in that same call — see apps/worker/worker.py's
  run_generate() and its --image path. This endpoint never talks to the
  model itself, so it needs nothing beyond what's already installed here.

Section model (replaces the archived classroom/lesson one — see
archive/b2b-classroom-poc and models.py's module docstring): content is either
global (every signed-in user, once a section is published) or personal (only
its owner). Sections form one self-referential tree; MAX_SECTION_DEPTH caps
how deep, in code rather than schema, so raising it later is a constant.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import mimetypes
import os
import pathlib
import time
from typing import Optional

from fastapi import Cookie, Depends, FastAPI, File, Form, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session, selectinload

from .auth import DUMMY_PASSWORD_HASH, current_user, end_session, hash_password, require_admin, start_session, verify_password
from .db import SessionLocal, get_session, init_db
from .models import Job, Page, Problem, Review, Section, User

app = FastAPI(title="JumpAIS")

# Where the worker drops a generated page (a draft — see apps/worker/worker.py)
# and where the `pages` nginx actually serves pages from. Two different volumes
# on purpose: this process is the only thing with write access to PUBLISHED_DIR,
# and it only ever writes there from review_page() below, on approval. A page
# nobody has approved has no copy in PUBLISHED_DIR and therefore no URL that
# serves it — not merely one nothing links to.
STORAGE_DIR = pathlib.Path(os.environ.get("STORAGE_DIR", "/storage"))
PUBLISHED_DIR = pathlib.Path(os.environ.get("PUBLISHED_DIR", "/published"))

# A section may nest this many levels below a root: root=0, so 0..2 is three
# levels total (book -> topic -> question). Enforced here, not in the schema —
# raising it later is a one-line change, not a migration. See models.py's
# Section docstring for why a fixed two-level shape did not fit every real
# exam book this was checked against.
MAX_SECTION_DEPTH = 2

# The kit's own vocabulary (kit/generate.py's EFFORT dict) — this API never
# invents a fourth level, it only decides which of these three a given
# request is allowed to ask for.
ALLOWED_EFFORTS = ("low", "medium", "high")

# A revision is a full generation-class model call (packages/kit/CLAUDE.md:
# ~90s, real cost), not the light lookup a tutor question is — same floor as
# fresh generation, for the same reason (see _validate_effort below).
MAX_REVISIONS_PER_PROBLEM = 10

# The kit's own vocabulary for POST /problems/{id}/similar (kit/generate.py's
# VARIATIONS dict) — one axis, not a taxonomy: "same" already means "same
# method, new numbers and dressing", which is the definition of a similar
# problem at unchanged difficulty; easier/harder scale that one axis instead
# of adding a second dimension for "how different".
ALLOWED_VARIATIONS = ("easier", "same", "harder")

# Generating a variant is a real generation-class model call against content
# the caller may only have READ (see revise_page's docstring on why that
# distinction matters) — capped per source, per user, so one popular global
# page can't have its cost spent by one account against every other account's
# ability to make their own variant of it.
MAX_SIMILAR_PER_SOURCE = 5

# Shared by every generation-class write (POST /problems, /similar, /revise):
# refuses a user's Nth concurrent generation while N-1 are already
# queued/running. WORKER_CONCURRENCY is 3 and shared by everyone, so one
# account queueing twenty at once would starve the rest of the app, same
# argument as MAX_SIMILAR_PER_SOURCE just at the level of the whole worker
# instead of one source problem.
MAX_INFLIGHT_GENERATE_PER_USER = 3


def _validate_effort(effort: Optional[str], *, allow_low: bool) -> Optional[str]:
    """None passes through unchanged — it means "let the worker fall back to
    its own default" (the GEN_EFFORT env var), same as before this existed.

    allow_low=False on every generation-class endpoint (fresh generation and
    revision): packages/kit/CLAUDE.md's medium-vs-high comparison (23 vs 35
    collisions, 1680 vs 1133 animated strokes, 268 vs 218 why-lines, over the
    full 68-problem bank) never tested low, and the project's own shipped
    default is high. A tutor question is a light, page-text-only lookup by
    design (see worker.py's TUTOR_SYSTEM_PROMPT) and defaults to low."""
    if effort is None:
        return None
    allowed = ALLOWED_EFFORTS if allow_low else tuple(e for e in ALLOWED_EFFORTS if e != "low")
    if effort not in allowed:
        raise HTTPException(400, f"effort must be one of: {', '.join(allowed)}")
    return effort


def _ensure_lib_link() -> None:
    """Generated pages load ./lib/shell.js relative to themselves. In the pages
    container PUBLISHED_DIR is mounted at html/generated and STORAGE_DIR at
    html/drafts, with the kit's lib at html/lib alongside both — so a `lib`
    symlink inside each one resolves to the vendored kit, the same arrangement
    the fixtures already use. They are relative symlinks, so each resolves
    correctly in whichever container reads it (nginx) regardless of where this
    process has the two dirs mounted.

    Both directories need the link, not just PUBLISHED_DIR: STORAGE_DIR is
    where every personal page is served from (personal content has no review
    gate — see models.py's Review docstring) and where a global page sits
    while awaiting review, so without this half a page in either state 404s
    its own shell and renders nothing, even though the checker reports it
    clean — check.mjs reads pages straight off disk and never goes through
    nginx's directory layout at all, so this gap has no automated check."""
    for base in (PUBLISHED_DIR, STORAGE_DIR):
        try:
            base.mkdir(parents=True, exist_ok=True)
            link = base / "lib"
            if not link.exists() and not link.is_symlink():
                link.symlink_to("../lib")
        except OSError:
            pass


# Real sessions need allow_credentials=True, which the browser refuses to pair
# with a wildcard origin — so WEB_ORIGIN has to be a real, explicit value (or
# comma-separated list) from here on, not "*". Set it in docker-compose.yml /
# .env to wherever the web app is actually served from.
_web_origins = [o.strip() for o in os.environ.get("WEB_ORIGIN", "http://localhost:5173").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_web_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _bootstrap_admins(db: Session) -> None:
    """ADMIN_EMAILS is a comma-separated allowlist, checked on every startup —
    both ways. It promotes an EXISTING account into the list and demotes any
    admin who has fallen out of it, because a var whose whole job is being the
    single source of truth for who can write the global library is not that
    if removing an email and restarting leaves the old admin able to write it
    forever. It never creates an account, because that would mean either
    inventing a password nobody knows or leaving one blank, and both are worse
    than "register first, then restart the api once." There is deliberately
    no endpoint that grants or revokes admin; this env var is the only path
    either way."""
    emails = {e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()}
    changed = False
    for user in db.query(User).filter(User.role == "admin").all():
        if user.email.lower() not in emails:
            user.role = "user"
            changed = True
    for email in emails:
        user = db.query(User).filter(func.lower(User.email) == email).first()
        if user is not None and user.role != "admin":
            user.role = "admin"
            changed = True
    if changed:
        db.commit()


@app.on_event("startup")
def _startup() -> None:
    init_db()
    _ensure_lib_link()
    db = SessionLocal()
    try:
        _bootstrap_admins(db)
    finally:
        db.close()


# ---------------------------------------------------------------- shapes ----


class RegisterIn(BaseModel):
    email: str
    password: str
    name: str


class LoginIn(BaseModel):
    email: str
    password: str


class SectionIn(BaseModel):
    parent_id: Optional[str] = None
    scope: str  # "global" | "personal"
    title: str
    kind: Optional[str] = None


class SectionUpdateIn(BaseModel):
    title: Optional[str] = None
    kind: Optional[str] = None
    position: Optional[int] = None
    parent_id: Optional[str] = None


class ProblemIn(BaseModel):
    """A personal problem as text — the core loop. `section_id` is optional:
    an unfiled problem lands in the caller's inbox (see GET /problems/mine).
    `effort` is optional — None lets the worker fall back to its own default
    (see _validate_effort); "low" is refused for generation."""

    text: str
    level: Optional[str] = None
    section_id: Optional[str] = None
    effort: Optional[str] = None


class GlobalProblemIn(BaseModel):
    """Same as ProblemIn, minus section_id — the section is the path segment
    on POST /sections/{id}/problems, since a global problem always belongs to
    exactly the section an admin filed it under."""

    text: str
    level: Optional[str] = None
    effort: Optional[str] = None


class BulkProblemsIn(BaseModel):
    items: list[GlobalProblemIn]


class ReviewIn(BaseModel):
    action: str  # approved | rejected
    note: Optional[str] = None
    seconds_on_page: Optional[int] = None


class AskIn(BaseModel):
    question: str
    effort: Optional[str] = None


class ReviseIn(BaseModel):
    """"Fix this page" instead of a fresh question — see POST /pages/{id}/revise.
    `effort` defaults to the page's own recorded effort when not given (see
    that endpoint): a small fix on a high-effort page should not silently
    downgrade it."""

    instruction: str
    effort: Optional[str] = None


class SimilarIn(BaseModel):
    """"Make one like this" instead of asking about it or fixing it — see
    POST /problems/{id}/similar. `variation` picks a canned difficulty line
    (see ALLOWED_VARIATIONS); `steer` is an optional free-text nudge on top
    of it, capped short because it rides straight into the model prompt."""

    variation: str = "same"
    steer: Optional[str] = None
    effort: Optional[str] = None


# Accepted image types for the two image-upload endpoints, mapped to the
# extension the file is stored under.
ALLOWED_IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
}
MAX_IMAGE_BYTES = 20 * 1024 * 1024

# How long POST /pages/{id}/ask waits on its tutor_ask job before giving up.
# Answering is one short JSON completion (see apps/worker/worker.py:
# ask_tutor()), normally a few seconds; the ceiling is generous mainly to
# cover the case where the single worker was already mid-generate when the
# question arrived (claim_one() gives tutor_ask priority in the QUEUE, but
# cannot interrupt a job already running).
ASK_TIMEOUT_SECONDS = 60.0


def _poll_job(job_id: str, timeout: float, interval: float = 0.3) -> Optional[Job]:
    """Poll a job row to completion from a plain (non-async) request handler.

    Uses its own short-lived session per poll instead of refreshing the
    request's Depends-injected one: Session.get() on an object already in the
    identity map can hand back the cached copy without a new SELECT, which
    would never observe the worker's commit. A fresh session has no identity
    map to be stale."""
    deadline = time.time() + timeout
    last: Optional[Job] = None
    while True:
        s = SessionLocal()
        try:
            last = s.get(Job, job_id)
            if last is not None:
                s.expunge(last)
        finally:
            s.close()
        if last is None or last.state in ("done", "failed"):
            return last
        if time.time() >= deadline:
            return last
        time.sleep(interval)


def _user_out(u: User) -> dict:
    return {"id": u.id, "email": u.email, "name": u.name, "role": u.role}


def page_out(p: Page) -> dict:
    return {
        "id": p.id,
        "problem_id": p.problem_id,
        "status": p.status,
        "kit_version": p.kit_version,
        "model": p.model,
        "effort": p.effort,
        "path_chosen": p.path_chosen,
        "html_path": p.html_path,
        "checks": p.checks_json,
        "created_at": p.created_at.isoformat() if p.created_at else None,
    }


def _problem_out(prob: Problem, page: Optional[Page], job_info: Optional[dict]) -> dict:
    return {
        "id": prob.id,
        "section_id": prob.section_id,
        "scope": prob.scope,
        "position": prob.position,
        "text": prob.extracted_text or prob.raw_text,
        "raw_text": prob.raw_text,
        "extracted_text": prob.extracted_text,
        "source": prob.source,
        "image_path": prob.image_path,
        "generated_from": prob.generated_from,
        "created_at": prob.created_at.isoformat() if prob.created_at else None,
        "page": page_out(page) if page else None,
        "job": job_info,
    }


def _active_generate_jobs(db: Session, problem_ids: list[str]) -> dict[str, dict]:
    """The most recent `generate` job for each of these problems, one query
    total rather than one per page-less problem. list_my_problems on a user
    with a few hundred problems was doing exactly that — a few hundred round
    trips to render their own home screen — before this existed."""
    if not problem_ids:
        return {}
    rows = (
        db.query(Job)
        .filter(Job.target_id.in_(problem_ids), Job.kind == "generate")
        .order_by(Job.target_id, Job.created_at.desc())
        .all()
    )
    out: dict[str, dict] = {}
    for j in rows:
        out.setdefault(j.target_id, {"id": j.id, "state": j.state, "stage": j.stage})
    return out


def _current_page(prob: Problem) -> Optional[Page]:
    current = [p for p in prob.pages if p.superseded_by is None]
    current.sort(key=lambda p: p.created_at or dt.datetime.min)
    return current[-1] if current else None


# ------------------------------------------------------------------- auth ----


@app.post("/auth/register", status_code=201)
def register(body: RegisterIn, response: Response, db: Session = Depends(get_session)):
    email = body.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(400, "a real-looking email is required")
    if len(body.password) < 8:
        raise HTTPException(400, "password must be at least 8 characters")
    if not body.name.strip():
        raise HTTPException(400, "name is required")
    if db.query(User).filter(func.lower(User.email) == email).first() is not None:
        raise HTTPException(409, "an account with this email already exists")
    user = User(email=email, password_hash=hash_password(body.password), name=body.name.strip())
    db.add(user)
    db.commit()
    start_session(db, user, response)
    return _user_out(user)


@app.post("/auth/login")
def login(body: LoginIn, response: Response, db: Session = Depends(get_session)):
    email = body.email.strip().lower()
    user = db.query(User).filter(func.lower(User.email) == email).first()
    # Checking the password against DUMMY_PASSWORD_HASH when there's no such
    # user, rather than short-circuiting, matters: PBKDF2 at this iteration
    # count takes ~250ms, and returning instantly for "no such email" against
    # ~250ms for "wrong password" is a hundredfold timing gap — a working
    # email-enumeration oracle with no statistics required, on an endpoint
    # with no other rate limit yet (see docs/BACKLOG.md).
    ok = verify_password(body.password, user.password_hash if user else DUMMY_PASSWORD_HASH)
    if user is None or not ok:
        raise HTTPException(401, "wrong email or password")
    start_session(db, user, response)
    return _user_out(user)


@app.post("/auth/logout")
def logout(
    response: Response,
    jumpais_session: Optional[str] = Cookie(default=None),
    db: Session = Depends(get_session),
):
    end_session(db, jumpais_session, response)
    return {"ok": True}


@app.get("/auth/me")
def me(user: User = Depends(current_user)):
    return _user_out(user)


# ---------------------------------------------------------------- sections --


def _section_out(s: Section) -> dict:
    return {
        "id": s.id,
        "parent_id": s.parent_id,
        "scope": s.scope,
        "owner_id": s.owner_id,
        "title": s.title,
        "kind": s.kind,
        "position": s.position,
        "depth": s.depth,
        "status": s.status,
        "published_at": s.published_at.isoformat() if s.published_at else None,
    }


def _is_section_visible(db: Session, section: Section) -> bool:
    """True only if this section AND every ancestor up to the root is
    published — a topic is not visible just because its book happens to be,
    nor the reverse. Cheap here because MAX_SECTION_DEPTH keeps the walk to
    at most three hops; would need a real query if that cap ever grows a lot.

    `seen` guards against a cycle even though update_section now refuses to
    create one (`_is_ancestor_or_self`) — this walk is unbounded otherwise,
    and one cyclic row from anywhere else (seed data, a manual DB fix, a
    future code path that forgets the check) would hang every request that
    reaches it rather than 500ing on just that section."""
    node: Optional[Section] = section
    seen = set()
    while node is not None:
        if node.status != "published":
            return False
        if node.id in seen:
            return False  # cyclic; treat as unpublished rather than hang
        seen.add(node.id)
        node = db.get(Section, node.parent_id) if node.parent_id else None
    return True


def _has_approved_descendant(section: Section, _seen: Optional[set] = None) -> bool:
    """Walks the whole subtree — a section may publish once ANY problem under
    it, at any depth, has an approved page. Small trees at this scale; a plain
    recursive walk over already-loaded relationships is enough. `_seen` is the
    same cycle guard as _is_section_visible's, for the same reason: recursion
    on a cycle is a stack overflow, not just a slow query."""
    seen = _seen if _seen is not None else set()
    if section.id in seen:
        return False
    seen.add(section.id)
    for prob in section.problems:
        page = _current_page(prob)
        if page is not None and page.status == "approved":
            return True
    for child in section.children:
        if child.archived_at is None and _has_approved_descendant(child, seen):
            return True
    return False


def _require_section_write(s: Section, user: User) -> None:
    if s.scope == "global":
        if user.role != "admin":
            raise HTTPException(403, "admin only")
    elif s.owner_id != user.id:
        raise HTTPException(403, "not your section")


def _ancestor_depth(db: Session, parent_id: Optional[str]) -> int:
    """The parent's REAL depth, counted by walking to the root, not read off
    its stored `depth` column. On create the two always agree; on move they
    can silently diverge (see update_section), and trusting the column there
    let a stale, under-reported depth pass the cap check indefinitely — move
    a subtree deeper, its old `depth` doesn't move with it, and the next
    create under it computes from the stale number. update_section fixes the
    stored column up afterward (`_reflow_depths`), but this cap check counts
    for itself precisely so it can never be fooled by a column that hasn't
    been fixed up yet, or ever."""
    depth = 0
    node_id = parent_id
    seen = set()
    while node_id is not None:
        if node_id in seen:
            raise HTTPException(500, "corrupt section tree: cycle detected")
        seen.add(node_id)
        node = db.get(Section, node_id)
        if node is None:
            raise HTTPException(404, "no such parent section")
        depth += 1
        node_id = node.parent_id
    return depth


def _compute_depth(db: Session, parent_id: Optional[str]) -> tuple[int, Optional[Section]]:
    if parent_id is None:
        return 0, None
    parent = db.get(Section, parent_id)
    if parent is None or parent.archived_at is not None:
        raise HTTPException(404, "no such parent section")
    depth = _ancestor_depth(db, parent_id)
    if depth > MAX_SECTION_DEPTH:
        raise HTTPException(400, f"sections nest at most {MAX_SECTION_DEPTH + 1} levels deep")
    return depth, parent


def _is_ancestor_or_self(db: Session, candidate_id: str, of_parent_id: Optional[str]) -> bool:
    """True if `candidate_id` is `of_parent_id` itself or one of ITS ancestors.
    Used to refuse `PATCH .../parent_id` moves that would make a section its
    own descendant. Without this, `_is_section_visible` (an unbounded `while
    node is not None` walk) loops forever on the resulting cycle the first
    time anyone hits GET /sections/global, and `_has_approved_descendant`
    (unbounded recursion) blows the stack the first time anyone publishes —
    both reachable by ANY signed-in user moving their own personal section
    under itself, not just an admin mistake on the global tree."""
    node_id = of_parent_id
    seen = set()
    while node_id is not None:
        if node_id == candidate_id:
            return True
        if node_id in seen:
            return True  # already-cyclic elsewhere; refuse rather than loop
        seen.add(node_id)
        node = db.get(Section, node_id)
        node_id = node.parent_id if node else None
    return False


def _subtree_height(section: Section) -> int:
    """0 for a leaf, else 1 + the tallest child subtree. Needed before a move
    is applied: moving a subtree with descendants deeper under a new parent
    can push ITS descendants past MAX_SECTION_DEPTH even when the section
    being moved lands within the cap itself."""
    live_children = [c for c in section.children if c.archived_at is None]
    if not live_children:
        return 0
    return 1 + max(_subtree_height(c) for c in live_children)


def _reflow_depths(section: Section) -> None:
    """After a move, `section.depth` is already correct — this fixes up
    everything BELOW it, which `_compute_depth` has no reason to touch.
    Skipping this is what let a stale descendant depth pass the cap check on
    a later create (see _ancestor_depth); this closes that at the source
    instead of only guarding against it downstream."""
    for child in section.children:
        if child.archived_at is None:
            child.depth = section.depth + 1
            _reflow_depths(child)


@app.get("/sections/global")
def list_global_sections(user: User = Depends(current_user), db: Session = Depends(get_session)):
    """Flat list, not a nested tree — the frontend assembles the tree from
    parent_id, which is one pass over a small list rather than the API
    shaping the same data two ways. Admins see every global section,
    including drafts (they are the ones editing the library); everyone else
    sees only what's fully published, ancestors included."""
    rows = db.query(Section).filter(Section.scope == "global", Section.archived_at.is_(None)).all()
    if user.role == "admin":
        return [_section_out(s) for s in rows]
    return [_section_out(s) for s in rows if _is_section_visible(db, s)]


@app.get("/sections/mine")
def list_my_sections(user: User = Depends(current_user), db: Session = Depends(get_session)):
    rows = (
        db.query(Section)
        .filter(Section.scope == "personal", Section.owner_id == user.id, Section.archived_at.is_(None))
        .all()
    )
    return [_section_out(s) for s in rows]


@app.post("/sections", status_code=201)
def create_section(body: SectionIn, user: User = Depends(current_user), db: Session = Depends(get_session)):
    if body.scope not in ("global", "personal"):
        raise HTTPException(400, "scope must be 'global' or 'personal'")
    if body.scope == "global" and user.role != "admin":
        raise HTTPException(403, "admin only")
    if not body.title.strip():
        raise HTTPException(400, "title is required")

    owner_id = None if body.scope == "global" else user.id
    depth, parent = _compute_depth(db, body.parent_id)
    if parent is not None:
        if parent.scope != body.scope or parent.owner_id != owner_id:
            raise HTTPException(400, "a section must nest under one of the same scope (and owner, if personal)")

    sibling_q = db.query(Section).filter(Section.scope == body.scope, Section.owner_id == owner_id)
    sibling_q = (
        sibling_q.filter(Section.parent_id == body.parent_id)
        if body.parent_id
        else sibling_q.filter(Section.parent_id.is_(None))
    )
    position = sibling_q.count()

    s = Section(
        parent_id=body.parent_id,
        scope=body.scope,
        owner_id=owner_id,
        title=body.title.strip(),
        kind=(body.kind or "").strip() or None,
        position=position,
        depth=depth,
        created_by=user.id,
    )
    db.add(s)
    db.commit()
    return _section_out(s)


@app.patch("/sections/{section_id}")
def update_section(
    section_id: str, body: SectionUpdateIn, user: User = Depends(current_user), db: Session = Depends(get_session)
):
    s = db.get(Section, section_id)
    if s is None or s.archived_at is not None:
        raise HTTPException(404, "no such section")
    _require_section_write(s, user)

    data = body.model_dump(exclude_unset=True)
    if "title" in data:
        if not (data["title"] and data["title"].strip()):
            raise HTTPException(400, "title is required")
        s.title = data["title"].strip()
    if "kind" in data:
        s.kind = (data["kind"] or "").strip() or None
    if "position" in data and data["position"] is not None:
        s.position = data["position"]
    if "parent_id" in data:
        new_parent_id = data["parent_id"]
        if new_parent_id is not None and _is_ancestor_or_self(db, s.id, new_parent_id):
            raise HTTPException(400, "cannot move a section under itself or one of its own descendants")
        depth, parent = _compute_depth(db, new_parent_id)
        if parent is not None and (parent.scope != s.scope or parent.owner_id != s.owner_id):
            raise HTTPException(400, "a section must nest under one of the same scope (and owner, if personal)")
        if depth + _subtree_height(s) > MAX_SECTION_DEPTH:
            raise HTTPException(400, f"moving here would nest sections more than {MAX_SECTION_DEPTH + 1} levels deep")
        s.parent_id = new_parent_id
        s.depth = depth
        _reflow_depths(s)
    db.commit()
    return _section_out(s)


@app.post("/sections/{section_id}/publish")
def publish_section(section_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_session)):
    """A section may publish once anything under it, at any depth, has an
    approved page. Each section in a chain is published independently — an
    admin publishes the book, and separately publishes each topic under it —
    rather than publishing a leaf implicitly cascading visibility upward."""
    s = db.get(Section, section_id)
    if s is None or s.archived_at is not None:
        raise HTTPException(404, "no such section")
    if s.scope != "global":
        raise HTTPException(400, "only global sections go through publish")
    if not _has_approved_descendant(s):
        raise HTTPException(409, {"error": "section has no approved problems to publish"})
    s.status = "published"
    s.published_at = dt.datetime.now(dt.timezone.utc)
    db.commit()
    return _section_out(s)


@app.post("/sections/{section_id}/unpublish")
def unpublish_section(section_id: str, admin: User = Depends(require_admin), db: Session = Depends(get_session)):
    """Revokes visibility only — mirrors the old unpublish_lesson exactly (see
    archive/b2b-classroom-poc): no page's approval or review history changes,
    and re-publishing needs no new approval."""
    s = db.get(Section, section_id)
    if s is None or s.archived_at is not None:
        raise HTTPException(404, "no such section")
    if s.scope != "global":
        raise HTTPException(400, "only global sections go through publish")
    s.status = "draft"
    s.published_at = None
    db.commit()
    return _section_out(s)


def _collect_problems(section: Section) -> list[Problem]:
    out = list(section.problems)
    for child in section.children:
        out.extend(_collect_problems(child))
    return out


@app.delete("/sections/{section_id}")
def delete_section(section_id: str, user: User = Depends(current_user), db: Session = Depends(get_session)):
    """Deletes the section and its whole subtree (ON DELETE CASCADE on
    parent_id). What happens to the problems filed anywhere in that subtree
    differs by scope, on purpose:

    Personal problems are left alone. Their section_id is set to NULL (ON
    DELETE SET NULL) and they fall back to being unfiled — deleting a folder
    must not silently destroy someone's own generated homework, and deleting
    a specific problem (see DELETE /problems/{id}) is the separate, explicit
    action for that.

    Global problems are deleted outright, along with their pages' files —
    mirroring the archived delete_lesson (see archive/b2b-classroom-poc).
    They CANNOT be left merely unfiled the way a personal one can: nothing in
    this API lists or manages a global problem with no section (there is no
    "global inbox"), so orphaning one here would leave its file sitting in
    PUBLISHED_DIR, served forever, with no row left that could ever unpublish
    or delete it again. An admin deleting a book means deleting what's in it."""
    s = db.get(Section, section_id)
    if s is None:
        raise HTTPException(404, "no such section")
    _require_section_write(s, user)

    problems = _collect_problems(s)
    # Null every one of these problems' pages' self-FK first, as its own bulk
    # UPDATE, flushed before any delete is even queued. Page.superseded_by has
    # no relationship() mapping for the ORM's unit-of-work to order a cascade
    # delete by, so once a revision chain exists (see POST /pages/{id}/revise)
    # letting the delete and the FK-null compete for ordering in the same
    # flush is exactly the kind of thing that works until the day it doesn't.
    # A separate, already-flushed statement sidesteps ordering entirely.
    page_ids = [page.id for prob in problems for page in prob.pages]
    if page_ids:
        db.query(Page).filter(Page.id.in_(page_ids)).update({"superseded_by": None}, synchronize_session=False)
        db.flush()

    for prob in problems:
        if prob.scope == "global":
            for page in prob.pages:
                _unpublish_page_file(page.html_path)
                _delete_storage_file(page.html_path)
            if prob.image_path:
                _delete_storage_file(prob.image_path)
            db.delete(prob)

    db.delete(s)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- problems --


@app.post("/problems", status_code=202)
def add_problem(body: ProblemIn, user: User = Depends(current_user), db: Session = Depends(get_session)):
    """Personal generation — the core loop. No section is required: an unfiled
    problem lands in the caller's inbox (see GET /problems/mine) rather than
    forcing a filing decision before the thing the user actually came for."""
    if not body.text.strip():
        raise HTTPException(400, "text is required")
    section = None
    if body.section_id:
        section = db.get(Section, body.section_id)
        if section is None or section.archived_at is not None:
            raise HTTPException(404, "no such section")
        if section.scope != "personal" or section.owner_id != user.id:
            raise HTTPException(403, "not your section")

    effort = _validate_effort(body.effort, allow_low=False)
    n = db.query(Problem).filter(Problem.owner_id == user.id).count()
    prob = Problem(
        section_id=section.id if section else None,
        scope="personal",
        owner_id=user.id,
        created_by=user.id,
        position=n,
        source="text",
        raw_text=body.text,
        level=body.level,
    )
    db.add(prob)
    db.flush()
    job = Job(kind="generate", target_id=prob.id, requested_by=user.id, state="queued",
              progress_json={"effort": effort} if effort else None)
    db.add(job)
    db.commit()
    return {"problem_id": prob.id, "job_id": job.id}


async def _read_image_upload(file: UploadFile) -> tuple[bytes, str]:
    data = await file.read()
    if not data:
        raise HTTPException(400, 'expected a file in the "file" field')
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(400, "file too large")
    ctype = (file.content_type or "").split(";")[0].strip().lower()
    ext = ALLOWED_IMAGE_TYPES.get(ctype)
    if ext is None:
        guessed, _ = mimetypes.guess_type(file.filename or "")
        ext = ALLOWED_IMAGE_TYPES.get(guessed or "")
    if ext is None:
        raise HTTPException(400, "unsupported image type; use png, jpeg, webp or heic")
    return data, ext


@app.post("/problems/image", status_code=202)
async def add_problem_image(
    file: UploadFile = File(...),
    text: Optional[str] = Form(None),
    level: Optional[str] = Form(None),
    section_id: Optional[str] = Form(None),
    effort: Optional[str] = Form(None),
    user: User = Depends(current_user),
    db: Session = Depends(get_session),
):
    """Same shape as add_problem() for a problem that arrives as a photo.
    Direct multimodal generation is used — the uploaded bytes are handed to
    the model alongside the prompt in one call (see apps/worker/worker.py's
    run_generate()) — and what the model restated the problem as lands in
    problem.extracted_text so it can be shown beside the page: the only
    defence against a misread photo now that no reviewer stands between
    generation and the person reading it."""
    section = None
    if section_id:
        section = db.get(Section, section_id)
        if section is None or section.archived_at is not None:
            raise HTTPException(404, "no such section")
        if section.scope != "personal" or section.owner_id != user.id:
            raise HTTPException(403, "not your section")

    eff = _validate_effort(effort, allow_low=False)
    data, ext = await _read_image_upload(file)
    n = db.query(Problem).filter(Problem.owner_id == user.id).count()
    prob = Problem(
        section_id=section.id if section else None,
        scope="personal",
        owner_id=user.id,
        created_by=user.id,
        position=n,
        source="image",
        raw_text=text.strip() if text and text.strip() else None,
        level=level.strip() if level and level.strip() else None,
    )
    db.add(prob)
    db.flush()  # need prob.id before naming the file on disk

    rel_path = f"uploads/{prob.id}{ext}"
    dest = STORAGE_DIR / rel_path
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    prob.image_path = rel_path

    job = Job(kind="generate", target_id=prob.id, requested_by=user.id, state="queued",
              progress_json={"effort": eff} if eff else None)
    db.add(job)
    db.commit()
    return {"problem_id": prob.id, "job_id": job.id, "image_path": rel_path}


@app.post("/sections/{section_id}/problems", status_code=202)
def add_global_problem(
    section_id: str, body: GlobalProblemIn, admin: User = Depends(require_admin), db: Session = Depends(get_session)
):
    if not body.text.strip():
        raise HTTPException(400, "text is required")
    section = db.get(Section, section_id)
    if section is None or section.archived_at is not None:
        raise HTTPException(404, "no such section")
    if section.scope != "global":
        raise HTTPException(400, "not a global section")
    effort = _validate_effort(body.effort, allow_low=False)
    n = db.query(Problem).filter(Problem.section_id == section_id).count()
    prob = Problem(
        section_id=section.id,
        scope="global",
        owner_id=None,
        created_by=admin.id,
        position=n,
        source="text",
        raw_text=body.text,
        level=body.level,
    )
    db.add(prob)
    db.flush()
    job = Job(kind="generate", target_id=prob.id, requested_by=admin.id, state="queued",
              progress_json={"effort": effort} if effort else None)
    db.add(job)
    db.commit()
    return {"problem_id": prob.id, "job_id": job.id}


@app.post("/sections/{section_id}/problems/bulk", status_code=202)
def add_global_problems_bulk(
    section_id: str, body: BulkProblemsIn, admin: User = Depends(require_admin), db: Session = Depends(get_session)
):
    """A past-papers book is forty questions. Adding them one at a time
    through a chat screen is the reason a global library stays empty — this
    is the fan-out that makes bulk import practical."""
    section = db.get(Section, section_id)
    if section is None or section.archived_at is not None:
        raise HTTPException(404, "no such section")
    if section.scope != "global":
        raise HTTPException(400, "not a global section")
    if not body.items:
        raise HTTPException(400, "no problems given")
    if any(not item.text.strip() for item in body.items):
        raise HTTPException(400, "every problem needs text")
    efforts = [_validate_effort(item.effort, allow_low=False) for item in body.items]
    n = db.query(Problem).filter(Problem.section_id == section_id).count()
    out = []
    for i, item in enumerate(body.items):
        prob = Problem(
            section_id=section.id,
            scope="global",
            owner_id=None,
            created_by=admin.id,
            position=n + i,
            source="text",
            raw_text=item.text,
            level=item.level,
        )
        db.add(prob)
        db.flush()
        job = Job(kind="generate", target_id=prob.id, requested_by=admin.id, state="queued",
                  progress_json={"effort": efforts[i]} if efforts[i] else None)
        db.add(job)
        out.append({"problem_id": prob.id, "job_id": job.id})
    db.commit()
    return out


@app.post("/sections/{section_id}/problems/image", status_code=202)
async def add_global_problem_image(
    section_id: str,
    file: UploadFile = File(...),
    text: Optional[str] = Form(None),
    level: Optional[str] = Form(None),
    effort: Optional[str] = Form(None),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
):
    section = db.get(Section, section_id)
    if section is None or section.archived_at is not None:
        raise HTTPException(404, "no such section")
    if section.scope != "global":
        raise HTTPException(400, "not a global section")

    eff = _validate_effort(effort, allow_low=False)
    data, ext = await _read_image_upload(file)
    n = db.query(Problem).filter(Problem.section_id == section_id).count()
    prob = Problem(
        section_id=section.id,
        scope="global",
        owner_id=None,
        created_by=admin.id,
        position=n,
        source="image",
        raw_text=text.strip() if text and text.strip() else None,
        level=level.strip() if level and level.strip() else None,
    )
    db.add(prob)
    db.flush()

    rel_path = f"uploads/{prob.id}{ext}"
    dest = STORAGE_DIR / rel_path
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    prob.image_path = rel_path

    job = Job(kind="generate", target_id=prob.id, requested_by=admin.id, state="queued",
              progress_json={"effort": eff} if eff else None)
    db.add(job)
    db.commit()
    return {"problem_id": prob.id, "job_id": job.id, "image_path": rel_path}


@app.get("/sections/{section_id}/problems")
def list_section_problems(section_id: str, user: User = Depends(current_user), db: Session = Depends(get_session)):
    section = db.get(Section, section_id)
    if section is None or section.archived_at is not None:
        raise HTTPException(404, "no such section")
    if section.scope == "personal" and section.owner_id != user.id:
        raise HTTPException(403, "not your section")
    if section.scope == "global" and user.role != "admin" and not _is_section_visible(db, section):
        return []

    approved_only = section.scope == "global" and user.role != "admin"
    rows = (
        db.query(Problem)
        .options(selectinload(Problem.pages))
        .filter(Problem.section_id == section_id)
        .order_by(Problem.position)
        .all()
    )
    pages = {p.id: _current_page(p) for p in rows}
    jobs = _active_generate_jobs(db, [p.id for p in rows if pages[p.id] is None])
    out = []
    for prob in rows:
        page = pages[prob.id]
        if approved_only and (page is None or page.status != "approved"):
            continue
        out.append(_problem_out(prob, page, jobs.get(prob.id)))
    return out


@app.get("/problems/mine")
def list_my_problems(user: User = Depends(current_user), db: Session = Depends(get_session)):
    """The personal library's inbox: every problem this user has ever
    generated, filed or not, newest first."""
    rows = (
        db.query(Problem)
        .options(selectinload(Problem.pages))
        .filter(Problem.owner_id == user.id)
        .order_by(Problem.created_at.desc())
        .all()
    )
    pages = {p.id: _current_page(p) for p in rows}
    jobs = _active_generate_jobs(db, [p.id for p in rows if pages[p.id] is None])
    return [_problem_out(prob, pages[prob.id], jobs.get(prob.id)) for prob in rows]


@app.delete("/problems/{problem_id}")
def delete_problem(problem_id: str, user: User = Depends(current_user), db: Session = Depends(get_session)):
    prob = db.get(Problem, problem_id)
    if prob is None:
        raise HTTPException(404, "no such problem")
    if prob.scope == "global":
        if user.role != "admin":
            raise HTTPException(403, "admin only")
    elif prob.owner_id != user.id:
        raise HTTPException(403, "not your problem")

    # Null the self-FK first, as its own flushed statement — see
    # delete_section's identical comment for why this can't just be an
    # attribute set inside the same flush as the deletes below.
    page_ids = [page.id for page in prob.pages]
    if page_ids:
        db.query(Page).filter(Page.id.in_(page_ids)).update({"superseded_by": None}, synchronize_session=False)
        db.flush()

    for page in prob.pages:
        _unpublish_page_file(page.html_path)
        _delete_storage_file(page.html_path)
    if prob.image_path:
        _delete_storage_file(prob.image_path)

    # Known simplification: unlike the old delete_problem (see
    # archive/b2b-classroom-poc), this does not re-check whether deleting the
    # last approved problem under a published section should unpublish it.
    # Rejecting a page still does that check (see review_page below); deleting
    # one outright does not yet walk the tree to re-validate. Flagged, not
    # silently accepted.
    db.delete(prob)
    db.commit()
    return {"ok": True}


@app.post("/problems/{problem_id}/similar", status_code=202)
def generate_similar(problem_id: str, body: SimilarIn, user: User = Depends(current_user), db: Session = Depends(get_session)):
    """"Make one like this" — a NEW problem, invented by the model from this
    one's text, always landing in the CALLER's own personal library. Never
    writes to the source in any way (contrast POST /pages/{id}/revise, which
    mutates a page in place and is personal-content-only for exactly that
    reason).

    That distinction is why a GLOBAL source is allowed here at all: revision
    is a write to content someone else owns (global content is admin-managed
    — see the section pivot's rule), which collides with the review gate the
    moment the source is already approved and published. This endpoint reads
    a page the caller can already see and creates something new that only
    the caller ever owns — no write to global content, no review-gate
    interaction, nothing anyone else can observe. A student reading an
    approved past-paper solution and asking for two more like it is the
    actual product case this exists for.

    Keyed on the PROBLEM, not the page (contrast revise, which is page-keyed
    because it edits one page's HTML): the source of a variant is the
    problem statement, which outlives any particular page rendering it, and
    a variant should still be traceable to a stable row even after its
    source has since been revised. Same argument BACKLOG already recorded
    for why a future chat-message table keys on problem_id, not page_id."""
    prob = db.get(Problem, problem_id)
    if prob is None:
        raise HTTPException(404, "no such problem")
    page = _current_page(prob)
    if page is None or not _page_visible(page, prob, user):
        raise HTTPException(404, "no such problem")
    if page.status not in ("ready", "approved"):
        raise HTTPException(409, {"error": "โจทย์นี้ยังสร้างไม่เสร็จ หรือยังนำมาใช้ไม่ได้"})

    variation = body.variation or "same"
    if variation not in ALLOWED_VARIATIONS:
        raise HTTPException(400, f"variation must be one of: {', '.join(ALLOWED_VARIATIONS)}")
    steer = (body.steer or "").strip() or None
    if steer and len(steer) > 500:
        raise HTTPException(400, "steer must be 500 characters or fewer")

    existing = db.query(Problem).filter(Problem.generated_from == prob.id, Problem.owner_id == user.id).count()
    if existing >= MAX_SIMILAR_PER_SOURCE:
        raise HTTPException(409, {"error": f"สร้างโจทย์คล้ายกันจากข้อนี้ได้สูงสุด {MAX_SIMILAR_PER_SOURCE} ข้อ"})

    inflight = (
        db.query(Job)
        .filter(Job.kind == "generate", Job.requested_by == user.id, Job.state.in_(("queued", "running")))
        .count()
    )
    if inflight >= MAX_INFLIGHT_GENERATE_PER_USER:
        raise HTTPException(409, {"error": "คุณมีงานที่กำลังสร้างอยู่หลายรายการแล้ว รอให้เสร็จก่อนสักครู่"})

    effort = _validate_effort(body.effort, allow_low=False) or page.effort

    # Inherit the source's own section only when it's a live personal one the
    # caller owns — never a global section_id. list_section_problems trusts
    # `Problem.section_id == section_id` alone, so an inherited global id
    # would put another user's personal problem in front of an admin
    # browsing that section; delete_section only deletes global-scope
    # problems in a global section's subtree, so a personal one landing
    # there would be orphaned into a section that no longer exists instead
    # of being cleaned up. Landing in the inbox is always safe; inheriting a
    # section is an optimisation, not a requirement.
    section_id = None
    if prob.scope == "personal" and prob.owner_id == user.id and prob.section_id:
        src_section = db.get(Section, prob.section_id)
        if src_section is not None and src_section.scope == "personal" and src_section.owner_id == user.id and src_section.archived_at is None:
            section_id = src_section.id

    n = db.query(Problem).filter(Problem.owner_id == user.id).count()
    new_prob = Problem(
        section_id=section_id,
        scope="personal",
        owner_id=user.id,
        created_by=user.id,
        position=n,
        source="variant",
        level=prob.level,
        generated_from=prob.id,
    )
    db.add(new_prob)
    db.flush()
    job = Job(
        kind="generate",
        target_id=new_prob.id,
        requested_by=user.id,
        state="queued",
        progress_json={"effort": effort, "variation": variation, "steer": steer, "source_problem_id": prob.id},
    )
    db.add(job)
    db.commit()
    return {"problem_id": new_prob.id, "job_id": job.id}


# ----------------------------------------------------------------- pages ----


def _page_visible(page: Page, prob: Optional[Problem], user: User) -> bool:
    """The one access rule for a page, used everywhere a page is read —
    GET /pages/{id}, POST /pages/{id}/ask, and the job endpoints below for
    whatever page a job's target resolves to. Written once specifically so it
    cannot drift the way it already has once (ask_page's own docstring used
    to claim this endpoint had no check at all, and separately claimed the
    worker's re-check "mirrors" this exactly when it had quietly stopped
    doing so — see apps/worker/worker.py's handle_tutor_ask).

    An admin sees everything, for review. Anyone signed in sees an approved
    (global) page. A personal page's owner sees it once it's `ready` — no
    review gate applies to personal content at all (see models.py's Review
    docstring), so `ready` is as far as "done" ever gets for one."""
    if user.role == "admin":
        return True
    if page.status == "approved":
        return True
    return bool(prob and prob.scope == "personal" and prob.owner_id == user.id and page.status == "ready")


@app.get("/pages/{page_id}")
def get_page(page_id: str, user: User = Depends(current_user), db: Session = Depends(get_session)):
    p = db.get(Page, page_id)
    if p is None:
        raise HTTPException(404, "no such page")
    prob = db.get(Problem, p.problem_id)
    # 404, not 403 — a stranger asking about someone's personal page gets the
    # same response whether the id is wrong or just not theirs to see, so the
    # response itself can't be used to confirm a guessed id exists.
    if not _page_visible(p, prob, user):
        raise HTTPException(404, "no such page")
    return page_out(p)


@app.post("/pages/{page_id}/ask")
def ask_page(page_id: str, body: AskIn, user: User = Depends(current_user), db: Session = Depends(get_session)):
    """The tutor chat. See _page_visible for the access rule this shares with
    GET /pages/{id} — the same rule, one definition, checked by both.

    Context comes ONLY from the page itself (its steps, each step's why, the
    answer and its sanity check) — never from a fresh solve. The model call
    happens in the worker (see the module docstring for why); this blocks on
    that job so the response stays the single synchronous {"answer", "cites"}
    the frontend expects, with no job/polling shape leaking out here."""
    page = db.get(Page, page_id)
    if page is None:
        raise HTTPException(404, "no such page")
    prob = db.get(Problem, page.problem_id)
    if not _page_visible(page, prob, user):
        raise HTTPException(409, {"error": "page is not available to ask about yet"})
    question = (body.question or "").strip()
    if not question:
        raise HTTPException(400, "question is required")
    effort = _validate_effort(body.effort, allow_low=True)

    # requested_by lets handle_tutor_ask (apps/worker/worker.py) re-check WHO
    # is allowed to see the answer it's about to write, not just whether the
    # page's status still permits asking about it at all — see that
    # function's docstring for why a status-only re-check isn't the same
    # claim as the one this endpoint just made.
    job = Job(
        kind="tutor_ask",
        target_id=page.id,
        requested_by=user.id,
        state="queued",
        progress_json={"question": question, "effort": effort},
    )
    db.add(job)
    db.commit()
    job_id = job.id

    result = _poll_job(job_id, timeout=ASK_TIMEOUT_SECONDS)
    if result is None or result.state not in ("done", "failed"):
        raise HTTPException(504, {"error": "tutor is taking too long to answer; try again"})
    if result.state == "failed":
        raise HTTPException(502, {"error": result.error or "tutor failed to answer"})

    progress = result.progress_json or {}
    return {"answer": progress.get("answer") or "", "cites": progress.get("cites") or []}


@app.post("/pages/{page_id}/revise", status_code=202)
def revise_page(page_id: str, body: ReviseIn, user: User = Depends(current_user), db: Session = Depends(get_session)):
    """"Fix this page" instead of asking about it — the model gets the page's
    own full HTML plus the instruction and is told to change only what's
    asked (see packages/kit/generate.py's build_revise_prompt()), not
    regenerate from scratch. Runs a real generation-class model call
    (~90s, see docs/BACKLOG.md's measurement) so this is asynchronous like
    POST /problems, not synchronous like /ask — the caller watches it with
    the same GET /jobs/{id}/events SSE stream a fresh generation uses.

    Personal content only for now. Global content is admin-managed and has a
    review gate an in-place revision would have to interact with correctly
    (does a revision of an approved page need to go back through review
    before replacing what's published, keeping the old one live meanwhile —
    yes, but that needs its own pass, not a corner cut into this one) — see
    docs/BACKLOG.md."""
    page = db.get(Page, page_id)
    if page is None:
        raise HTTPException(404, "no such page")
    prob = db.get(Problem, page.problem_id)
    if not _page_visible(page, prob, user):
        raise HTTPException(404, "no such page")
    if prob is None or prob.scope != "personal" or prob.owner_id != user.id:
        raise HTTPException(403, "revising global content isn't available yet — see docs/BACKLOG.md")
    if page.status not in ("ready", "approved", "rejected"):
        raise HTTPException(409, {"error": "page isn't finished generating yet"})
    if page.superseded_by is not None:
        raise HTTPException(409, {"error": "a newer version of this page already exists"})
    if not page.html_path:
        raise HTTPException(409, {"error": "page has no stored html to revise"})

    instruction = (body.instruction or "").strip()
    if not instruction:
        raise HTTPException(400, "instruction is required")

    live_pages = db.query(Page).filter(Page.problem_id == prob.id, Page.superseded_by.is_(None)).count()
    if live_pages > 1:
        # Only reachable once global revision exists (deferred superseding on
        # an approved page can leave an old-and-a-pending-revision both live)
        # — unreachable today since personal content always supersedes
        # immediately, but the guard costs nothing and documents the
        # invariant for when that changes.
        raise HTTPException(409, {"error": "this problem already has a pending revision"})
    total_pages = db.query(Page).filter(Page.problem_id == prob.id).count()
    if total_pages >= MAX_REVISIONS_PER_PROBLEM:
        raise HTTPException(409, {"error": f"a problem can be revised at most {MAX_REVISIONS_PER_PROBLEM} times"})

    # generate jobs key on target_id == the problem directly; revise jobs key
    # on target_id == the PAGE being revised, so the problem id is denormalised
    # into progress_json instead (see the Job created below) — filtered in
    # Python rather than a JSON-path SQL comparison, since the queued/running
    # set at this scale is always tiny and a plain equality check on parsed
    # JSON is far less fragile across JSON vs JSONB column behaviour.
    active = db.query(Job).filter(Job.kind.in_(("generate", "revise")), Job.state.in_(("queued", "running"))).all()
    for j in active:
        if (j.kind == "generate" and j.target_id == prob.id) or (
            j.kind == "revise" and (j.progress_json or {}).get("problem_id") == prob.id
        ):
            raise HTTPException(409, {"error": "this problem already has a generation in progress"})

    effort = _validate_effort(body.effort, allow_low=False) or page.effort

    job = Job(
        kind="revise",
        target_id=page.id,
        requested_by=user.id,
        state="queued",
        progress_json={"instruction": instruction, "effort": effort, "problem_id": prob.id},
    )
    db.add(job)
    db.commit()
    return {"job_id": job.id, "from_page_id": page.id}


def _publish_page_file(html_path: Optional[str]) -> None:
    """The other half of the confirmation gate: approving a page in Postgres
    means nothing unless the pages origin can actually serve it. Copies from
    STORAGE_DIR (where the worker left the draft) into PUBLISHED_DIR (what
    nginx mounts). A missing source is not fatal here — it means the page
    predates this file, or storage was pruned, and there is nothing to copy
    either way."""
    if not html_path:
        return
    src = STORAGE_DIR / html_path
    if not src.exists():
        return
    PUBLISHED_DIR.mkdir(parents=True, exist_ok=True)
    (PUBLISHED_DIR / html_path).write_bytes(src.read_bytes())


def _unpublish_page_file(html_path: Optional[str]) -> None:
    """Reverses _publish_page_file. Used when a page's approval is reversed —
    a rejected page must stop being servable, not just stop being linked."""
    if not html_path:
        return
    dst = PUBLISHED_DIR / html_path
    if dst.exists():
        dst.unlink()


def _delete_storage_file(rel_path: Optional[str]) -> None:
    """Deletes a file from STORAGE_DIR (drafts, uploads) when an entity is deleted."""
    if not rel_path:
        return
    dst = STORAGE_DIR / rel_path
    if dst.exists() and not dst.is_dir():
        try:
            dst.unlink()
        except OSError:
            pass


@app.post("/pages/{page_id}/review")
def review_page(page_id: str, body: ReviewIn, admin: User = Depends(require_admin), db: Session = Depends(get_session)):
    """The confirmation gate — global content only. Personal content has no
    review row at all (see models.py's Review docstring): nobody is protected
    by making a user approve their own page, and a self-approve button is
    exactly the rubber-stamp failure seconds_on_page exists to catch.

    This is the only place a page's HTML is ever copied into PUBLISHED_DIR —
    approving here and only here is what makes it reachable by URL at all."""
    p = db.get(Page, page_id)
    if p is None:
        raise HTTPException(404, "no such page")
    prob = db.get(Problem, p.problem_id)
    if prob is None or prob.scope != "global":
        raise HTTPException(400, "only global content goes through review")
    if body.action not in ("approved", "rejected"):
        raise HTTPException(400, "action must be approved or rejected")

    db.add(
        Review(
            page_id=p.id,
            reviewer_id=admin.id,
            action=body.action,
            note=body.note,
            seconds_on_page=body.seconds_on_page,
        )
    )
    p.status = body.action

    # Rejecting the only approved problem under a published section breaks
    # the invariant publish was built to hold. Revoke that ONE section's
    # visibility so a re-check is forced before it's trusted again — see
    # publish_section's docstring for why this does not walk further up the
    # tree to re-validate ancestors published on the strength of this same
    # problem; that gap is a known simplification, not silently accepted.
    if body.action == "rejected" and prob.section_id:
        section = db.get(Section, prob.section_id)
        if section is not None and section.status == "published" and not _has_approved_descendant(section):
            section.status = "draft"
            section.published_at = None

    db.commit()
    if body.action == "approved":
        _publish_page_file(p.html_path)
    else:
        _unpublish_page_file(p.html_path)
    return page_out(p)


# ------------------------------------------------------------------ jobs ----


def _job_visible(db: Session, job: Job, user: User) -> bool:
    """A job's `progress_json` can hold real content — a tutor_ask's question
    and answer, or a revise's instruction, in particular (see
    handle_tutor_ask/handle_revise in apps/worker/worker.py) — so this needs
    the same ownership check page reads get, not just "is signed in".
    `target_id` means a different table depending on `kind`: a Problem for
    `generate`, a Page for `tutor_ask` and `revise` alike (whose own
    visibility in turn depends on its Problem — see _page_visible)."""
    if user.role == "admin":
        return True
    if job.kind == "generate":
        prob = db.get(Problem, job.target_id)
        return prob is None or prob.scope == "global" or prob.owner_id == user.id
    if job.kind in ("tutor_ask", "revise"):
        page = db.get(Page, job.target_id)
        if page is None:
            return True
        prob = db.get(Problem, page.problem_id)
        return _page_visible(page, prob, user)
    return True


@app.get("/jobs/{job_id}")
def get_job(job_id: str, user: User = Depends(current_user), db: Session = Depends(get_session)):
    j = db.get(Job, job_id)
    if j is None or not _job_visible(db, j, user):
        raise HTTPException(404, "no such job")
    return {"id": j.id, "state": j.state, "stage": j.stage, "progress": j.progress_json, "error": j.error}


@app.get("/jobs/{job_id}/events")
async def job_events(job_id: str, user: User = Depends(current_user), db: Session = Depends(get_session)):
    """Server-sent events for one job.

    Generation takes 30-90 seconds. A spinner for that long kills a live demo,
    and the checks produce genuinely interesting output, so the client streams
    this and shows the work: which drawing path was chosen, what the checker
    found. Watching a page get audited is a better thing to look at than a
    spinner, and it is honest about what the system actually does.
    """
    j = db.get(Job, job_id)
    if j is None or not _job_visible(db, j, user):
        raise HTTPException(404, "no such job")

    async def stream():
        last = None
        for _ in range(600):  # ~10 minutes, then the client can reconnect
            db = SessionLocal()
            try:
                j = db.get(Job, job_id)
                if j is None:
                    yield f"data: {json.dumps({'error': 'no such job'})}\n\n"
                    return
                payload = {
                    "state": j.state,
                    "stage": j.stage,
                    "progress": j.progress_json,
                    "error": j.error,
                }
                blob = json.dumps(payload, ensure_ascii=False)
                if blob != last:
                    yield f"data: {blob}\n\n"
                    last = blob
                if j.state in ("done", "failed"):
                    return
            finally:
                db.close()
            await asyncio.sleep(1)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/healthz")
def healthz():
    return {"ok": True}
