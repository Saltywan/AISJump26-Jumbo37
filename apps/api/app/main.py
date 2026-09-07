"""The API.

It never serves page HTML. Pages are written to the shared storage volume and
served by the `pages` origin, so the app can embed them in an opaque-origin
sandboxed iframe. That is the containment for model-written JavaScript, and it
is why `checks_json` is stored and served from here — the app has no way to read
anything out of a page.

It also has no model dependency of its own — google-genai is only installed in
the worker image (apps/worker/Dockerfile), and this file's owned surface for
this change does not include apps/api/Dockerfile. So both model-backed
features below hand off to a worker job and answer synchronously by polling
that job's row rather than calling the model in this process:

- POST /pages/{page_id}/ask  creates a `tutor_ask` job and waits on it
  (see _poll_job below, and apps/worker/worker.py: handle_tutor_ask()).
- POST /lessons/{id}/problems/image  saves the upload and queues an ordinary
  `generate` job; the worker restates the photo into problem.extracted_text
  before generating, from inside that same job (see
  apps/worker/worker.py: restate_image()). This endpoint itself never talks
  to the model, so it needs nothing beyond what's already installed here.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import mimetypes
import os
import pathlib
import re
import time
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .db import SessionLocal, get_session, init_db
from .models import Classroom, Job, Lesson, Page, Problem, Review

app = FastAPI(title="JumpAIS")

# Where the worker drops a generated page (a draft — see apps/worker/worker.py)
# and where the `pages` nginx actually serves pages from. Two different volumes
# on purpose: this process is the only thing with write access to PUBLISHED_DIR,
# and it only ever writes there from review_page() below, on approval. A page
# nobody has approved has no copy in PUBLISHED_DIR and therefore no URL that
# serves it — not merely one nothing links to.
STORAGE_DIR = pathlib.Path(os.environ.get("STORAGE_DIR", "/storage"))
PUBLISHED_DIR = pathlib.Path(os.environ.get("PUBLISHED_DIR", "/published"))


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

web_origin = os.environ.get("WEB_ORIGIN", "*")
allow_origins = ["*"] if web_origin == "*" else [o.strip() for o in web_origin.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    init_db()
    _ensure_lib_link()


# ---------------------------------------------------------------- shapes ----


class ClassroomIn(BaseModel):
    name: str
    subject: Optional[str] = None
    level: Optional[str] = None


class ClassroomUpdateIn(BaseModel):
    name: Optional[str] = None
    subject: Optional[str] = None
    level: Optional[str] = None


class LessonIn(BaseModel):
    title: str
    chapter: Optional[str] = None


class ProblemIn(BaseModel):
    """A problem as text. Images go to POST /lessons/{id}/problems/image, which
    hands the file to the model directly rather than OCRing it first."""

    text: str
    level: Optional[str] = None


class ReviewIn(BaseModel):
    action: str  # approved | rejected
    note: Optional[str] = None
    seconds_on_page: Optional[int] = None
    reviewer: Optional[str] = None


class AskIn(BaseModel):
    question: str


# Accepted image types for POST /lessons/{id}/problems/image, mapped to the
# extension the file is stored under (see add_problem_image()).
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


# The hand-rolled multipart reader that used to live here is gone. It existed
# only because adding python-multipart meant touching the API Dockerfile, which
# was outside one agent's file scope — a scoping artifact, not an engineering
# reason. Parsing untrusted multipart bodies by hand is not something to own
# when a maintained parser is one line of Dockerfile away.
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


# ------------------------------------------------------------ classrooms ----


@app.get("/classrooms")
def list_classrooms(db: Session = Depends(get_session)):
    rows = db.query(Classroom).filter(Classroom.archived_at.is_(None)).all()
    return [
        {
            "id": c.id,
            "name": c.name,
            "subject": c.subject,
            "level": c.level,
            "lesson_count": len(c.lessons),
        }
        for c in rows
    ]


@app.post("/classrooms", status_code=201)
def create_classroom(body: ClassroomIn, db: Session = Depends(get_session)):
    c = Classroom(name=body.name, subject=body.subject, level=body.level)
    db.add(c)
    db.commit()
    return {"id": c.id}


@app.get("/classrooms/{classroom_id}")
def get_classroom(classroom_id: str, db: Session = Depends(get_session)):
    c = db.get(Classroom, classroom_id)
    if c is None or c.archived_at is not None:
        raise HTTPException(404, "no such classroom")
    return {
        "id": c.id,
        "name": c.name,
        "subject": c.subject,
        "level": c.level,
        "lesson_count": len(c.lessons),
    }


@app.patch("/classrooms/{classroom_id}")
def update_classroom(classroom_id: str, body: ClassroomUpdateIn, db: Session = Depends(get_session)):
    c = db.get(Classroom, classroom_id)
    if c is None or c.archived_at is not None:
        raise HTTPException(404, "no such classroom")
    if body.name is not None and body.name.strip():
        c.name = body.name.strip()
    if body.subject is not None:
        c.subject = body.subject.strip() or None
    if body.level is not None:
        c.level = body.level.strip() or None
    db.commit()
    return {
        "id": c.id,
        "name": c.name,
        "subject": c.subject,
        "level": c.level,
        "lesson_count": len(c.lessons),
    }


@app.delete("/classrooms/{classroom_id}")
def delete_classroom(classroom_id: str, db: Session = Depends(get_session)):
    c = db.get(Classroom, classroom_id)
    if c is None or c.archived_at is not None:
        raise HTTPException(404, "no such classroom")
    c.archived_at = dt.datetime.now(dt.timezone.utc)
    for lesson in c.lessons:
        lesson.status = "draft"
        for prob in lesson.problems:
            for page in prob.pages:
                _unpublish_page_file(page.html_path)
                _delete_storage_file(page.html_path)
            if prob.image_path:
                _delete_storage_file(prob.image_path)
    db.commit()
    return {"ok": True}


@app.get("/classrooms/{classroom_id}/lessons")
def list_lessons(
    classroom_id: str,
    published_only: bool = False,
    db: Session = Depends(get_session),
):
    """`published_only` is the confirmation gate as the API sees it. The student
    app asks with it set; a lesson that has not been confirmed is not merely
    hidden in the UI, it is not returned."""
    c = db.get(Classroom, classroom_id)
    if c is None or c.archived_at is not None:
        raise HTTPException(404, "no such classroom")
    q = db.query(Lesson).filter(Lesson.classroom_id == classroom_id)
    if published_only:
        q = q.filter(Lesson.status == "published")
    rows = q.order_by(Lesson.position).all()
    out = []
    for l in rows:
        waiting = 0
        approved_count = 0
        for prob in l.problems:
            current = [p for p in prob.pages if p.superseded_by is None]
            page = current[-1] if current else None
            if page is None or page.status != "approved":
                waiting += 1
            else:
                approved_count += 1
        out.append(
            {
                "id": l.id,
                "title": l.title,
                "chapter": l.chapter,
                "status": l.status,
                "problem_count": approved_count if published_only else len(l.problems),
                "waiting_count": waiting,
            }
        )
    return out


@app.post("/classrooms/{classroom_id}/lessons", status_code=201)
def create_lesson(classroom_id: str, body: LessonIn, db: Session = Depends(get_session)):
    if db.get(Classroom, classroom_id) is None:
        raise HTTPException(404, "no such classroom")
    n = db.query(Lesson).filter(Lesson.classroom_id == classroom_id).count()
    l = Lesson(classroom_id=classroom_id, title=body.title, chapter=body.chapter, position=n)
    db.add(l)
    db.commit()
    return {"id": l.id}


@app.delete("/lessons/{lesson_id}")
def delete_lesson(lesson_id: str, db: Session = Depends(get_session)):
    lesson = db.get(Lesson, lesson_id)
    if lesson is None:
        raise HTTPException(404, "no such lesson")
    for prob in lesson.problems:
        for page in prob.pages:
            _unpublish_page_file(page.html_path)
            _delete_storage_file(page.html_path)
        if prob.image_path:
            _delete_storage_file(prob.image_path)
    db.delete(lesson)
    db.commit()
    return {"ok": True}


@app.post("/lessons/{lesson_id}/publish")
def publish_lesson(lesson_id: str, db: Session = Depends(get_session)):
    """A lesson may be published when at least one problem in it has an approved page."""
    lesson = db.get(Lesson, lesson_id)
    if lesson is None:
        raise HTTPException(404, "no such lesson")

    has_approved = False
    for prob in lesson.problems:
        current = [p for p in prob.pages if p.superseded_by is None]
        if any(p.status == "approved" for p in current):
            has_approved = True
            break
    if not has_approved:
        raise HTTPException(
            409,
            {"error": "lesson has no approved problems to publish"},
        )

    lesson.status = "published"
    lesson.published_at = dt.datetime.now(dt.timezone.utc)
    db.commit()
    return {"id": lesson.id, "status": lesson.status}


@app.post("/lessons/{lesson_id}/unpublish")
def unpublish_lesson(lesson_id: str, db: Session = Depends(get_session)):
    """Undo a publish — the demo's safety valve for a mis-click, mirrored from
    the same control on the old localStorage-only build. This only revokes
    *visibility*: `published_only` stops returning the lesson, so a student
    session that asks after this call sees it disappear. It does not touch any
    page's `status` or its copy in PUBLISHED_DIR, and it writes no `review` row
    — approval is an audit trail of events that happened, not a live flag, and
    erasing it here would make "why was this approved" unanswerable later for
    no safety benefit: re-publishing needs no new approval, since the pages are
    still approved. If a specific page must stop being served, reject it via
    POST /pages/{id}/review instead — that is what removes its file."""
    lesson = db.get(Lesson, lesson_id)
    if lesson is None:
        raise HTTPException(404, "no such lesson")
    lesson.status = "draft"
    lesson.published_at = None
    db.commit()
    return {"id": lesson.id, "status": lesson.status}


# -------------------------------------------------------------- problems ----


@app.post("/lessons/{lesson_id}/problems", status_code=202)
def add_problem(lesson_id: str, body: ProblemIn, db: Session = Depends(get_session)):
    """Queue a problem for generation. Returns immediately with a job to watch —
    generation takes 30-90 seconds and the client streams /jobs/{id}/events."""
    if db.get(Lesson, lesson_id) is None:
        raise HTTPException(404, "no such lesson")
    n = db.query(Problem).filter(Problem.lesson_id == lesson_id).count()
    prob = Problem(
        lesson_id=lesson_id,
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


@app.post("/lessons/{lesson_id}/problems/image", status_code=202)
async def add_problem_image(
    lesson_id: str,
    file: UploadFile = File(...),
    text: Optional[str] = Form(None),
    level: Optional[str] = Form(None),
    db: Session = Depends(get_session),
):
    """Same shape and same queue as add_problem() above, for a problem that
    arrives as a photo instead of typed text. Direct multimodal generation is
    used: uploaded bytes are saved under STORAGE_DIR, and the generator model
    reads the image bytes directly along with instructions in a single call,
    eliminating intermediate text transcription loss. The problem statement
    synthesized in Shell.page() is then saved into problem.extracted_text so a
    teacher can review what the model understood against the photo before
    publishing."""
    if db.get(Lesson, lesson_id) is None:
        raise HTTPException(404, "no such lesson")

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

    n = db.query(Problem).filter(Problem.lesson_id == lesson_id).count()
    prob = Problem(
        lesson_id=lesson_id,
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


@app.get("/lessons/{lesson_id}/problems")
def list_problems(lesson_id: str, approved_only: bool = False, db: Session = Depends(get_session)):
    lesson = db.get(Lesson, lesson_id)
    if lesson is None:
        raise HTTPException(404, "no such lesson")
    # A second gate, not a duplicate of the first: `published_only` on the
    # lessons list keeps a student from ever being handed this lesson_id, but
    # a bookmarked or guessed one is still a valid id to ask about directly.
    # Without this, unpublishing a lesson (see /lessons/{id}/unpublish) would
    # stop it appearing in lists while every one of its already-approved pages
    # stayed answerable here by anyone who still had the URL.
    if approved_only and lesson.status != "published":
        return []
    rows = (
        db.query(Problem)
        .filter(Problem.lesson_id == lesson_id)
        .order_by(Problem.position)
        .all()
    )
    out = []
    for prob in rows:
        current = [p for p in prob.pages if p.superseded_by is None]
        current.sort(key=lambda p: p.created_at or dt.datetime.min)
        page = current[-1] if current else None
        if approved_only and (page is None or page.status != "approved"):
            continue

        job_info = None
        if page is None:
            active_job = (
                db.query(Job)
                .filter(Job.target_id == prob.id, Job.kind == "generate")
                .order_by(Job.created_at.desc())
                .first()
            )
            if active_job:
                job_info = {
                    "id": active_job.id,
                    "state": active_job.state,
                    "stage": active_job.stage,
                }

        out.append(
            {
                "id": prob.id,
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
        )
    return out


@app.delete("/problems/{problem_id}")
def delete_problem(problem_id: str, db: Session = Depends(get_session)):
    prob = db.get(Problem, problem_id)
    if prob is None:
        raise HTTPException(404, "no such problem")
    lesson = db.get(Lesson, prob.lesson_id)

    for page in prob.pages:
        _unpublish_page_file(page.html_path)
        _delete_storage_file(page.html_path)
    if prob.image_path:
        _delete_storage_file(prob.image_path)

    if lesson is not None and lesson.status == "published":
        has_other_approved = False
        for other_prob in lesson.problems:
            if other_prob.id == prob.id:
                continue
            current = [pg for pg in other_prob.pages if pg.superseded_by is None]
            if any(pg.status == "approved" for pg in current):
                has_other_approved = True
                break
        if not has_other_approved:
            lesson.status = "draft"
            lesson.published_at = None

    db.delete(prob)
    db.commit()
    return {"ok": True}


# ----------------------------------------------------------------- pages ----


@app.get("/pages/{page_id}")
def get_page(page_id: str, db: Session = Depends(get_session)):
    p = db.get(Page, page_id)
    if p is None:
        raise HTTPException(404, "no such page")
    return page_out(p)


@app.post("/pages/{page_id}/ask")
def ask_page(page_id: str, body: AskIn, db: Session = Depends(get_session)):
    """The student tutor chat. 409s if the page is not `approved` — a draft
    has not been through review, and letting a student ask an unconstrained
    model about it beside the review gate quietly defeats the point of that
    gate. Context comes ONLY from the approved page itself (its steps, each
    step's why, the answer and its sanity check) — never from a fresh solve —
    which is exactly why this has to wait for the page to exist and be
    approved before it can answer anything.

    The model call happens in the worker (see the module docstring for why)
    behind a `tutor_ask` job; this blocks on that job so the response stays
    the single synchronous {"answer", "cites"} the frontend contract expects,
    with no job/polling shape leaking out of this endpoint."""
    page = db.get(Page, page_id)
    if page is None:
        raise HTTPException(404, "no such page")
    if page.status != "approved":
        raise HTTPException(409, {"error": "page is not approved"})
    question = (body.question or "").strip()
    if not question:
        raise HTTPException(400, "question is required")

    job = Job(kind="tutor_ask", target_id=page.id, state="queued",
              progress_json={"question": question})
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
    means nothing to a student unless the pages origin can actually serve it.
    Copies from STORAGE_DIR (where the worker left the draft) into
    PUBLISHED_DIR (what nginx mounts) — see the module-level comment and
    apps/worker/worker.py. A missing source is not fatal here: it means the
    page predates this file, or storage was pruned, and there is nothing to
    copy either way."""
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
def review_page(page_id: str, body: ReviewIn, db: Session = Depends(get_session)):
    """The confirmation. seconds_on_page is recorded because rubber-stamping is
    this design's silent failure — if approving is slow, a teacher clicks
    through without reading and every metric stays green.

    This is also the only place a page's HTML is ever copied into PUBLISHED_DIR,
    the directory the pages origin actually serves — approving here and only
    here is what makes the page reachable by URL at all (see
    _publish_page_file). Rejecting removes it again, even if it had been
    approved and served before."""
    p = db.get(Page, page_id)
    if p is None:
        raise HTTPException(404, "no such page")
    if body.action not in ("approved", "rejected"):
        raise HTTPException(400, "action must be approved or rejected")
    db.add(
        Review(
            page_id=p.id,
            action=body.action,
            note=body.note,
            seconds_on_page=body.seconds_on_page,
        )
    )
    p.status = body.action

    # Rejecting a page inside a published lesson breaks the invariant publish
    # was built to hold: every problem has an approved page. Left alone the
    # lesson stays published and a student opens "3 จาก 3" to find one missing.
    # Revoke the lesson's visibility and make a teacher confirm it again. The
    # approvals on its other pages are untouched, so re-publishing is one click
    # once the rejected page is replaced.
    if body.action == "rejected":
        prob = db.get(Problem, p.problem_id)
        lesson = db.get(Lesson, prob.lesson_id) if prob else None
        if lesson is not None and lesson.status == "published":
            has_other_approved = False
            for other_prob in lesson.problems:
                current = [pg for pg in other_prob.pages if pg.superseded_by is None]
                if any(pg.id != p.id and pg.status == "approved" for pg in current):
                    has_other_approved = True
                    break
            if not has_other_approved:
                lesson.status = "draft"
                lesson.published_at = None

    db.commit()
    if body.action == "approved":
        _publish_page_file(p.html_path)
    else:
        _unpublish_page_file(p.html_path)
    return page_out(p)


# ------------------------------------------------------------------ jobs ----


@app.get("/jobs/{job_id}")
def get_job(job_id: str, db: Session = Depends(get_session)):
    j = db.get(Job, job_id)
    if j is None:
        raise HTTPException(404, "no such job")
    return {"id": j.id, "state": j.state, "stage": j.stage, "progress": j.progress_json, "error": j.error}


@app.get("/jobs/{job_id}/events")
async def job_events(job_id: str):
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
