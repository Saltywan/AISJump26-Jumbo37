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
from sqlalchemy.orm import Session

from .auth import current_user, end_session, hash_password, require_admin, start_session, verify_password
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


def _ensure_lib_link() -> None:
    """Generated pages load ./lib/shell.js relative to themselves. In the pages
    container PUBLISHED_DIR is mounted at html/generated and the kit's lib at
    html/lib, so a `lib` symlink inside PUBLISHED_DIR resolves to the vendored
    kit — the same arrangement the fixtures already use. It is a relative
    symlink, so it resolves correctly in whichever container reads it (nginx)
    regardless of where this process has PUBLISHED_DIR mounted. Without it every
    approved page 404s its own shell and renders nothing."""
    try:
        PUBLISHED_DIR.mkdir(parents=True, exist_ok=True)
        link = PUBLISHED_DIR / "lib"
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
    """ADMIN_EMAILS is a comma-separated allowlist, checked on every startup.
    It promotes an EXISTING account — it never creates one, because that would
    mean either inventing a password nobody knows or leaving one blank, and
    both are worse than "the admin has to register first, then restart the
    api once." There is deliberately no endpoint that grants admin; this env
    var is the only path."""
    emails = [e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()]
    if not emails:
        return
    changed = False
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
    an unfiled problem lands in the caller's inbox (see GET /problems/mine)."""

    text: str
    level: Optional[str] = None
    section_id: Optional[str] = None


class GlobalProblemIn(BaseModel):
    """Same as ProblemIn, minus section_id — the section is the path segment
    on POST /sections/{id}/problems, since a global problem always belongs to
    exactly the section an admin filed it under."""

    text: str
    level: Optional[str] = None


class BulkProblemsIn(BaseModel):
    items: list[GlobalProblemIn]


class ReviewIn(BaseModel):
    action: str  # approved | rejected
    note: Optional[str] = None
    seconds_on_page: Optional[int] = None


class AskIn(BaseModel):
    question: str


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


def _problem_out(prob: Problem, page: Optional[Page], db: Session) -> dict:
    job_info = None
    if page is None:
        active_job = (
            db.query(Job)
            .filter(Job.target_id == prob.id, Job.kind == "generate")
            .order_by(Job.created_at.desc())
            .first()
        )
        if active_job:
            job_info = {"id": active_job.id, "state": active_job.state, "stage": active_job.stage}
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
        "created_at": prob.created_at.isoformat() if prob.created_at else None,
        "page": page_out(page) if page else None,
        "job": job_info,
    }


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
    if user is None or not verify_password(body.password, user.password_hash):
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
    at most three hops; would need a real query if that cap ever grows a lot."""
    node: Optional[Section] = section
    while node is not None:
        if node.status != "published":
            return False
        node = db.get(Section, node.parent_id) if node.parent_id else None
    return True


def _has_approved_descendant(section: Section) -> bool:
    """Walks the whole subtree — a section may publish once ANY problem under
    it, at any depth, has an approved page. Small trees at this scale; a plain
    recursive walk over already-loaded relationships is enough."""
    for prob in section.problems:
        page = _current_page(prob)
        if page is not None and page.status == "approved":
            return True
    for child in section.children:
        if child.archived_at is None and _has_approved_descendant(child):
            return True
    return False


def _require_section_write(s: Section, user: User) -> None:
    if s.scope == "global":
        if user.role != "admin":
            raise HTTPException(403, "admin only")
    elif s.owner_id != user.id:
        raise HTTPException(403, "not your section")


def _compute_depth(db: Session, parent_id: Optional[str]) -> tuple[int, Optional[Section]]:
    if parent_id is None:
        return 0, None
    parent = db.get(Section, parent_id)
    if parent is None or parent.archived_at is not None:
        raise HTTPException(404, "no such parent section")
    depth = parent.depth + 1
    if depth > MAX_SECTION_DEPTH:
        raise HTTPException(400, f"sections nest at most {MAX_SECTION_DEPTH + 1} levels deep")
    return depth, parent


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
    if "title" in data and data["title"] and data["title"].strip():
        s.title = data["title"].strip()
    if "kind" in data:
        s.kind = (data["kind"] or "").strip() or None
    if "position" in data and data["position"] is not None:
        s.position = data["position"]
    if "parent_id" in data:
        # Depth on this row is recomputed; a moved subtree's OWN descendants
        # keep their old depth values until they are individually touched.
        # Fine at this scale (three levels, POC content) and flagged rather
        # than silently wrong — a real fix walks the subtree on every move.
        depth, parent = _compute_depth(db, data["parent_id"])
        if parent is not None and (parent.scope != s.scope or parent.owner_id != s.owner_id):
            raise HTTPException(400, "a section must nest under one of the same scope (and owner, if personal)")
        s.parent_id = data["parent_id"]
        s.depth = depth
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


@app.delete("/sections/{section_id}")
def delete_section(section_id: str, user: User = Depends(current_user), db: Session = Depends(get_session)):
    """Deletes the section and its whole subtree (ON DELETE CASCADE on
    parent_id). Problems filed anywhere in that subtree are NOT deleted —
    their section_id is set to NULL (ON DELETE SET NULL) and they fall back
    to being unfiled. Deleting an organising folder should not silently
    destroy the generations inside it; deleting a specific problem (see
    DELETE /problems/{id}) is the explicit, separate action for that."""
    s = db.get(Section, section_id)
    if s is None:
        raise HTTPException(404, "no such section")
    _require_section_write(s, user)
    db.delete(s)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- problems --


@app.post("/problems", status_code=202)
def add_problem(body: ProblemIn, user: User = Depends(current_user), db: Session = Depends(get_session)):
    """Personal generation — the core loop. No section is required: an unfiled
    problem lands in the caller's inbox (see GET /problems/mine) rather than
    forcing a filing decision before the thing the user actually came for."""
    section = None
    if body.section_id:
        section = db.get(Section, body.section_id)
        if section is None or section.archived_at is not None:
            raise HTTPException(404, "no such section")
        if section.scope != "personal" or section.owner_id != user.id:
            raise HTTPException(403, "not your section")

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
    job = Job(kind="generate", target_id=prob.id, state="queued")
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

    job = Job(kind="generate", target_id=prob.id, state="queued")
    db.add(job)
    db.commit()
    return {"problem_id": prob.id, "job_id": job.id, "image_path": rel_path}


@app.post("/sections/{section_id}/problems", status_code=202)
def add_global_problem(
    section_id: str, body: GlobalProblemIn, admin: User = Depends(require_admin), db: Session = Depends(get_session)
):
    section = db.get(Section, section_id)
    if section is None or section.archived_at is not None:
        raise HTTPException(404, "no such section")
    if section.scope != "global":
        raise HTTPException(400, "not a global section")
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
    job = Job(kind="generate", target_id=prob.id, state="queued")
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
        job = Job(kind="generate", target_id=prob.id, state="queued")
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
    admin: User = Depends(require_admin),
    db: Session = Depends(get_session),
):
    section = db.get(Section, section_id)
    if section is None or section.archived_at is not None:
        raise HTTPException(404, "no such section")
    if section.scope != "global":
        raise HTTPException(400, "not a global section")

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

    job = Job(kind="generate", target_id=prob.id, state="queued")
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
    rows = db.query(Problem).filter(Problem.section_id == section_id).order_by(Problem.position).all()
    out = []
    for prob in rows:
        page = _current_page(prob)
        if approved_only and (page is None or page.status != "approved"):
            continue
        out.append(_problem_out(prob, page, db))
    return out


@app.get("/problems/mine")
def list_my_problems(user: User = Depends(current_user), db: Session = Depends(get_session)):
    """The personal library's inbox: every problem this user has ever
    generated, filed or not, newest first."""
    rows = db.query(Problem).filter(Problem.owner_id == user.id).order_by(Problem.created_at.desc()).all()
    return [_problem_out(prob, _current_page(prob), db) for prob in rows]


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


# ----------------------------------------------------------------- pages ----


@app.get("/pages/{page_id}")
def get_page(page_id: str, user: User = Depends(current_user), db: Session = Depends(get_session)):
    p = db.get(Page, page_id)
    if p is None:
        raise HTTPException(404, "no such page")
    return page_out(p)


@app.post("/pages/{page_id}/ask")
def ask_page(page_id: str, body: AskIn, user: User = Depends(current_user), db: Session = Depends(get_session)):
    """The tutor chat. For global content this still requires `approved` — a
    draft has not been through review, and letting anyone ask an
    unconstrained model about it beside the review gate quietly defeats the
    point of that gate. For personal content there is no review gate at all
    (see models.py's Review docstring), so `ready` is enough — but only for
    its own owner; this is the one place a personal page's access actually is
    checked, unlike GET /pages/{id} itself.

    Context comes ONLY from the page itself (its steps, each step's why, the
    answer and its sanity check) — never from a fresh solve. The model call
    happens in the worker (see the module docstring for why); this blocks on
    that job so the response stays the single synchronous {"answer", "cites"}
    the frontend expects, with no job/polling shape leaking out here."""
    page = db.get(Page, page_id)
    if page is None:
        raise HTTPException(404, "no such page")
    prob = db.get(Problem, page.problem_id)
    allowed = page.status == "approved" or (
        prob is not None and prob.scope == "personal" and prob.owner_id == user.id and page.status == "ready"
    )
    if not allowed:
        raise HTTPException(409, {"error": "page is not available to ask about yet"})
    question = (body.question or "").strip()
    if not question:
        raise HTTPException(400, "question is required")

    job = Job(kind="tutor_ask", target_id=page.id, state="queued", progress_json={"question": question})
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


@app.get("/jobs/{job_id}")
def get_job(job_id: str, user: User = Depends(current_user), db: Session = Depends(get_session)):
    j = db.get(Job, job_id)
    if j is None:
        raise HTTPException(404, "no such job")
    return {"id": j.id, "state": j.state, "stage": j.stage, "progress": j.progress_json, "error": j.error}


@app.get("/jobs/{job_id}/events")
async def job_events(job_id: str, user: User = Depends(current_user)):
    """Server-sent events for one job.

    Generation takes 30-90 seconds. A spinner for that long kills a live demo,
    and the checks produce genuinely interesting output, so the client streams
    this and shows the work: which drawing path was chosen, what the checker
    found. Watching a page get audited is a better thing to look at than a
    spinner, and it is honest about what the system actually does.
    """

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
