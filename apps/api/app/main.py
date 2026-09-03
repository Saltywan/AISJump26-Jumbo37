"""The API.

It never serves page HTML. Pages are written to the shared storage volume and
served by the `pages` origin, so the app can embed them in an opaque-origin
sandboxed iframe. That is the containment for model-written JavaScript, and it
is why `checks_json` is stored and served from here — the app has no way to read
anything out of a page.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .db import SessionLocal, get_session, init_db
from .models import Classroom, Job, Lesson, Page, Problem, Review

app = FastAPI(title="JumpAIS")

# The web app is a different origin in dev (5173 vs 8000). The pages origin is
# NOT listed: it never talks to this API, and it must not be able to.
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("WEB_ORIGIN", "http://localhost:5173").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    init_db()


# ---------------------------------------------------------------- shapes ----


class ClassroomIn(BaseModel):
    name: str
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


@app.get("/classrooms/{classroom_id}/lessons")
def list_lessons(
    classroom_id: str,
    published_only: bool = False,
    db: Session = Depends(get_session),
):
    """`published_only` is the confirmation gate as the API sees it. The student
    app asks with it set; a lesson that has not been confirmed is not merely
    hidden in the UI, it is not returned."""
    q = db.query(Lesson).filter(Lesson.classroom_id == classroom_id)
    if published_only:
        q = q.filter(Lesson.status == "published")
    return [
        {
            "id": l.id,
            "title": l.title,
            "chapter": l.chapter,
            "status": l.status,
            "problem_count": len(l.problems),
        }
        for l in q.order_by(Lesson.position).all()
    ]


@app.post("/classrooms/{classroom_id}/lessons", status_code=201)
def create_lesson(classroom_id: str, body: LessonIn, db: Session = Depends(get_session)):
    if db.get(Classroom, classroom_id) is None:
        raise HTTPException(404, "no such classroom")
    n = db.query(Lesson).filter(Lesson.classroom_id == classroom_id).count()
    l = Lesson(classroom_id=classroom_id, title=body.title, chapter=body.chapter, position=n)
    db.add(l)
    db.commit()
    return {"id": l.id}


@app.post("/lessons/{lesson_id}/publish")
def publish_lesson(lesson_id: str, db: Session = Depends(get_session)):
    """A lesson may only be published when every problem in it has an approved
    page. Otherwise a student opens "2 จาก 4" and finds nothing there."""
    lesson = db.get(Lesson, lesson_id)
    if lesson is None:
        raise HTTPException(404, "no such lesson")

    # An empty lesson is the degenerate case of the same rule and it slipped
    # through the first time: with no problems, "every problem has an approved
    # page" is vacuously true, so a lesson containing nothing published happily
    # and students saw an empty shell.
    if not lesson.problems:
        raise HTTPException(409, {"error": "lesson has no problems yet"})

    unapproved = []
    for prob in lesson.problems:
        current = [p for p in prob.pages if p.superseded_by is None]
        if not any(p.status == "approved" for p in current):
            unapproved.append(prob.id)
    if unapproved:
        raise HTTPException(
            409,
            {
                "error": "lesson has problems with no approved page",
                "problems": unapproved,
            },
        )

    lesson.status = "published"
    lesson.published_at = dt.datetime.now(dt.timezone.utc)
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
        extracted_text=body.text,
        level=body.level,
    )
    db.add(prob)
    db.flush()
    job = Job(kind="generate", target_id=prob.id, state="queued")
    db.add(job)
    db.commit()
    return {"problem_id": prob.id, "job_id": job.id}


@app.get("/lessons/{lesson_id}/problems")
def list_problems(lesson_id: str, approved_only: bool = False, db: Session = Depends(get_session)):
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
        out.append(
            {
                "id": prob.id,
                "position": prob.position,
                "text": prob.extracted_text or prob.raw_text,
                "source": prob.source,
                "page": page_out(page) if page else None,
            }
        )
    return out


# ----------------------------------------------------------------- pages ----


@app.get("/pages/{page_id}")
def get_page(page_id: str, db: Session = Depends(get_session)):
    p = db.get(Page, page_id)
    if p is None:
        raise HTTPException(404, "no such page")
    return page_out(p)


@app.post("/pages/{page_id}/review")
def review_page(page_id: str, body: ReviewIn, db: Session = Depends(get_session)):
    """The confirmation. seconds_on_page is recorded because rubber-stamping is
    this design's silent failure — if approving is slow, a teacher clicks
    through without reading and every metric stays green."""
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
    db.commit()
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
