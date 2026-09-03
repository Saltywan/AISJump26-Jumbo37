"""The generation worker.

It shells out to the kit — `kit/generate.py` to write the page and
`kit/checks/check.mjs` to measure it — and records the result. It does not
reimplement either. Those two are the measured, working core of the whole
research repo; a second implementation in service code would fork the thing
that exists to keep this honest.

    job(generate) -> generate.py  -> page html
                  -> check.mjs --json -> checks_json
                  -> page.status = 'ready'   (a DRAFT: no student sees it yet)

The page is written into the shared storage volume, which the `pages` nginx
serves from its own origin. The API never serves page HTML: generated pages run
model-written JavaScript, and the separate origin plus an opaque-origin iframe
is the containment.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, "/app")

from app.db import SessionLocal, init_db  # noqa: E402
from app.models import Job, Page, Problem  # noqa: E402

KIT = pathlib.Path(os.environ.get("KIT_DIR", "/kit"))
STORAGE = pathlib.Path(os.environ.get("STORAGE_DIR", "/storage"))
MODEL = os.environ.get("GEN_MODEL", "gemini-3.8-flash")
EFFORT = os.environ.get("GEN_EFFORT", "high")
POLL_SECONDS = 2


def log(*a):
    print(*a, flush=True)


def ensure_lib_link() -> None:
    """Generated pages load ./lib/shell.js relative to themselves. In the pages
    container the storage volume is mounted at html/pages and the kit's lib at
    html/lib, so a `lib` symlink beside the pages resolves to the vendored kit —
    the same arrangement the fixtures already use. Without it every page 404s
    its own shell and renders nothing."""
    link = STORAGE / "lib"
    if not link.exists() and not link.is_symlink():
        try:
            link.symlink_to("../lib")
            log("worker: created storage/lib -> ../lib")
        except OSError as e:
            log(f"worker: could not create lib symlink: {e}")


def kit_version() -> str:
    """Whatever the vendored kit says it is. Stored on every page, because
    re-executing an old page against a newer kit is a first-class operation
    here and it needs to know what it was made against."""
    f = KIT / "VERSION"
    if not f.exists():
        return "unknown"
    for line in f.read_text(encoding="utf-8").splitlines():
        if line.startswith("source-commit:"):
            return line.split(":", 1)[1].strip()[:12]
    return "unknown"


def set_stage(db, job: Job, stage: str, **progress) -> None:
    job.stage = stage
    job.progress_json = {**(job.progress_json or {}), **progress, "stage": stage}
    db.commit()


def run_generate(problem: Problem, out_dir: pathlib.Path, db, job: Job) -> pathlib.Path | None:
    """One problem through generate.py. Its batch file format is id|โจทย์|ระดับ."""
    text = (problem.extracted_text or problem.raw_text or "").strip()
    if not text:
        raise RuntimeError("problem has no text")

    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as fh:
        fh.write(f"{problem.id}|{text}|{problem.level or ''}\n")
        batch = fh.name

    set_stage(db, job, "generating", model=MODEL, effort=EFFORT)
    cmd = [
        "python3", str(KIT / "generate.py"),
        "-f", batch,
        "--out", str(out_dir),
        "--model", MODEL,
        "--effort", EFFORT,
        "--jobs", "1",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    log(proc.stdout[-2000:])
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout)[-500:])

    pages = sorted((out_dir / "pages").glob("*.html"))
    return pages[0] if pages else None


def run_check(page_file: pathlib.Path, db, job: Job) -> dict | None:
    """check.mjs --json gives exactly the row the review screen reads. The app
    cannot read anything out of the page itself — it is embedded in an
    opaque-origin sandbox on purpose — so the report has to be produced here."""
    set_stage(db, job, "checking")
    out = page_file.parent.parent / "checks.json"
    cmd = ["node", str(KIT / "checks" / "check.mjs"), "--json", str(out), str(page_file)]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    log(proc.stdout[-2000:])
    if not out.exists():
        log(f"worker: check produced no json: {(proc.stderr or '')[-300:]}")
        return None
    rows = json.loads(out.read_text(encoding="utf-8"))
    return rows[0] if rows else None


def handle_generate(db, job: Job) -> None:
    problem = db.get(Problem, job.target_id)
    if problem is None:
        raise RuntimeError(f"problem {job.target_id} is gone")

    work = STORAGE / "runs" / job.id
    work.mkdir(parents=True, exist_ok=True)

    page_file = run_generate(problem, work, db, job)
    if page_file is None:
        raise RuntimeError("generate produced no page")

    # Check it where generate.py left it, NOT after copying to storage.
    # generate.py writes a relative pages/lib symlink beside the page, which
    # resolves to the kit here in the worker. The storage/lib symlink points at
    # ../lib, which only resolves inside the pages nginx container — so checking
    # the copied file made every page load its shell from nowhere and report
    # itself as zero steps and six console errors, a broken page that was fine.
    checks = run_check(page_file, db, job)
    html = page_file.read_text(encoding="utf-8", errors="replace")

    # Then publish into the storage root, where the pages origin serves it.
    final_name = f"{problem.id}.html"
    final = STORAGE / final_name
    final.write_bytes(page_file.read_bytes())

    page = Page(
        problem_id=problem.id,
        kit_version=kit_version(),
        model=MODEL,
        effort=EFFORT,
        html_path=final_name,
        path_chosen="board" if "Shell.board(" in html else "svg",
        checks_json=checks,
        # 'ready' is a DRAFT. A teacher still has to look at it and confirm
        # before any student sees it — see docs/SCHEMA.md. Nothing here
        # approves anything.
        status="ready",
    )
    db.add(page)
    db.flush()          # the id is generated on flush; without this the job
                        # progress reported page_id: null and the client that
                        # streams it had nothing to open
    set_stage(db, job, "done", page_id=page.id)
    db.commit()


def claim_one(db) -> Job | None:
    """Single worker, so a plain SELECT is honest. With more than one this
    wants SKIP LOCKED — noted here rather than pretended."""
    job = (
        db.query(Job)
        .filter(Job.state == "queued")
        .order_by(Job.created_at.asc())
        .first()
    )
    if job is None:
        return None
    job.state = "running"
    job.attempts += 1
    job.started_at = dt.datetime.now(dt.timezone.utc)
    db.commit()
    return job


def main() -> None:
    init_db()
    ensure_lib_link()
    log(f"worker: up. kit={kit_version()} model={MODEL} effort={EFFORT}")
    while True:
        db = SessionLocal()
        try:
            job = claim_one(db)
            if job is None:
                time.sleep(POLL_SECONDS)
                continue
            log(f"worker: job {job.id} {job.kind} -> {job.target_id}")
            try:
                if job.kind == "generate":
                    handle_generate(db, job)
                else:
                    raise RuntimeError(f"unknown job kind {job.kind}")
                job.state = "done"
            except Exception as e:  # noqa: BLE001 - a failed job must not kill the loop
                log(f"worker: job {job.id} failed: {e}")
                job.state = "failed"
                job.error = str(e)[:2000]
                set_stage(db, job, "failed", error=str(e)[:500])
            job.finished_at = dt.datetime.now(dt.timezone.utc)
            db.commit()
        finally:
            db.close()


if __name__ == "__main__":
    main()
