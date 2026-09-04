"""The generation worker.

It shells out to the kit — `kit/generate.py` to write the page and
`kit/checks/check.mjs` to measure it — and records the result. It does not
reimplement either. Those two are the measured, working core of the whole
research repo; a second implementation in service code would fork the thing
that exists to keep this honest.

    job(generate) -> generate.py  -> page html
                  -> check.mjs --json -> checks_json
                  -> page.status = 'ready'   (a DRAFT: no student sees it yet)

The page is written into the `storage` volume, which is private to this worker
and the API — the `pages` nginx that actually serves generated pages does not
mount it and cannot read it. `storage` holds drafts; `published` (mounted only
by the API and by `pages`) holds what a teacher has approved. This worker never
writes there — see review_page() in apps/api/app/main.py, which copies a page
into `published` the moment, and only the moment, a teacher approves it. A page
this process finishes is a draft no student can reach by any URL until that
happens, not merely one nothing links to.

Two more job kinds live here, both added for the student/teacher-facing
features below, and both call the model directly with google-genai rather than
shelling out — there is nothing in kit/ for either of them to wrap:

`generate` on an image-sourced problem now restates the photo into text before
doing anything else (see restate_image()) — the model reads the image
directly, no OCR step, and what it read back is stored as
problem.extracted_text for a teacher to catch a misread against.

`tutor_ask` answers a student's question about one already-approved page (see
handle_tutor_ask() / ask_tutor()). It is routed through this worker rather than
called from the API process because google-genai is only installed in this
image — the API's Dockerfile is out of scope for this change — and the API
answers it synchronously by polling the job row it created (see
apps/api/app/main.py: ask_page()/_poll_job()). claim_one() below jumps a
queued tutor_ask ahead of generate/recheck jobs so a chat question does not
sit behind a 30-90 second page generation that happened to be queued first;
it cannot preempt one already *running*, since this is still a single
sequential worker.
"""
from __future__ import annotations

import datetime as dt
import json
import mimetypes
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, "/app")

from app.db import SessionLocal, init_db  # noqa: E402
from app.models import Job, Page, Problem  # noqa: E402

try:
    from google import genai
    from google.genai import types
except ImportError:                                       # pragma: no cover
    genai = types = None

KIT = pathlib.Path(os.environ.get("KIT_DIR", "/kit"))
STORAGE = pathlib.Path(os.environ.get("STORAGE_DIR", "/storage"))
MODEL = os.environ.get("GEN_MODEL", "gemini-3.8-flash")
EFFORT = os.environ.get("GEN_EFFORT", "high")
POLL_SECONDS = 2


def log(*a):
    print(*a, flush=True)


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


# --------------------------------------------------------------- model calls
# Both restate_image() and ask_tutor() call google-genai directly. Neither is
# "generation" in the kit's sense — one turns a photo into text, the other
# turns an approved page into a chat answer — so routing them through
# kit/generate.py would mean teaching that script inputs it was never built
# for. GOOGLE_CLOUD_API_KEY is the same key generate.py itself reads.

_client = None


def genai_client():
    global _client
    if _client is None:
        if genai is None:
            raise RuntimeError("google-genai is not installed in this image")
        key = os.environ.get("GOOGLE_CLOUD_API_KEY")
        if not key:
            raise RuntimeError("GOOGLE_CLOUD_API_KEY not set")
        _client = genai.Client(vertexai=True, api_key=key,
                                http_options=types.HttpOptions(timeout=120_000))
    return _client


def _safety_off():
    return [
        types.SafetySetting(category=c, threshold="OFF")
        for c in (
            "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_DANGEROUS_CONTENT",
            "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_HARASSMENT",
        )
    ]


def _retry_transient(fn, tries: int = 4, base_delay: float = 2.0):
    """Small version of generate.py's call_with_backoff for the two short
    calls below — a chat answer and a restatement are a few seconds each, not
    worth the full batch-oriented retry loop, but a bare 429 still should not
    fail a job outright."""
    last = None
    for attempt in range(tries):
        try:
            return fn()
        except Exception as e:                             # noqa: BLE001
            last = e
            msg = str(e)
            transient = ("429" in msg or "RESOURCE_EXHAUSTED" in msg
                         or "503" in msg or "UNAVAILABLE" in msg)
            if not transient or attempt == tries - 1:
                raise
            time.sleep(base_delay * (attempt + 1))
    raise last  # pragma: no cover


def _strip_fences(text: str) -> str:
    """The model occasionally wraps a plain-text answer in a markdown fence
    (see generate.py's own strip_fences, which this mirrors in miniature for
    the same reason: a leading fence line has broken output before)."""
    return "\n".join(l for l in text.splitlines() if not l.strip().startswith("```"))


RESTATE_PROMPT = (
    "รูปภาพนี้เป็นภาพถ่ายโจทย์คณิตศาสตร์หรือฟิสิกส์ระดับมัธยมปลาย "
    "อ่านโจทย์ในรูปอย่างละเอียดแล้วเขียนโจทย์นั้นขึ้นใหม่เป็นข้อความล้วน "
    "ห้ามแก้ไข ห้ามเพิ่มเติม ห้ามตัดทอน และห้ามแก้โจทย์ให้ดูสมเหตุสมผลขึ้นถ้าโจทย์ในรูปดูผิดปกติ "
    "คงตัวเลข ตัวแปร และหน่วยทุกตัวไว้ตรงกับต้นฉบับที่เห็นในรูป ใช้ $...$ ล้อมสัญลักษณ์คณิตศาสตร์ "
    "ห้ามแก้โจทย์ ห้ามเฉลย ห้ามอธิบายวิธีทำ และห้ามมีคำนำหรือคำลงท้าย "
    "ตอบกลับเฉพาะข้อความโจทย์ที่ถอดได้จากรูปเท่านั้น"
)


def restate_image(problem: Problem, db, job: Job) -> str:
    """The model reads the uploaded photo directly — there is no separate OCR
    step — and this is what it says the photo shows, BEFORE anything tries to
    solve it. It is stored on problem.extracted_text and is the only defence
    against a misread photo: a flawless page solving the wrong problem passes
    every automated check, and a teacher can only catch that by comparing this
    restatement against the photo at confirmation time (see docs/SCHEMA.md and
    docs/BUILD-PLAN.html §04 wanting the review screen to surface exactly the
    things automated checks cannot see)."""
    if not problem.image_path:
        raise RuntimeError(f"problem {problem.id} has source=image but no image_path")
    img_path = STORAGE / problem.image_path
    if not img_path.exists():
        raise RuntimeError(f"problem {problem.id} image missing on disk: {img_path}")

    set_stage(db, job, "extracting")
    mime = mimetypes.guess_type(img_path.name)[0] or "image/jpeg"
    data = img_path.read_bytes()
    client = genai_client()
    config = types.GenerateContentConfig(
        max_output_tokens=4096,
        safety_settings=_safety_off(),
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        thinking_config=types.ThinkingConfig(thinking_level="LOW"),
    )
    contents = [types.Content(role="user", parts=[
        types.Part.from_bytes(data=data, mime_type=mime),
        types.Part.from_text(text=RESTATE_PROMPT),
    ])]

    def call():
        resp = client.models.generate_content(model=MODEL, contents=contents, config=config)
        text = _strip_fences((resp.text or "").strip())
        if not text.strip():
            raise RuntimeError("empty restatement from model")
        return text.strip()

    return _retry_transient(call)


# ------------------------------------------------------- page-context lookup
# The tutor chat's context comes from the approved page's steps, each step's
# why, and the answer plus its sanity check — never from a fresh solve (see
# apps/api/app/main.py: ask_page()). Those live in the page's stored HTML as
# plain calls the generated <script> makes: Shell.step(text, {why, uses}),
# Shell.setup(text) and Shell.answer(label, value, {sanity}) — see
# packages/kit/lib/shell.js. They are NOT in checks_json: check.mjs's
# `explain` block (window.__shellCheck.explain, lintExplanation() in
# shell.js) is only counts for the review screen — steps, withWhy, groups,
# missingWhy — never the step text itself. So this reads the call arguments
# straight out of the page's own source with a small hand-rolled tokenizer.
# That is cheaper and more reliable at request time than the alternative,
# which would be launching a browser (what check.mjs does, using the
# Playwright this image already has) just to scrape rendered DOM text back
# out of a page nothing here is supposed to execute.


def _skip_js_string(src: str, i: int) -> int:
    """src[i] is a quote character. Return the index just past the matching
    unescaped closing quote."""
    quote = src[i]
    i += 1
    n = len(src)
    while i < n:
        c = src[i]
        if c == "\\":
            i += 2
            continue
        if c == quote:
            return i + 1
        i += 1
    return i


def _find_matching_paren(src: str, open_idx: int) -> int:
    """src[open_idx] == '('. Return the index of the matching ')', respecting
    nested (), [], {} and JS string/template literals."""
    depth = 0
    i = open_idx
    n = len(src)
    while i < n:
        c = src[i]
        if c in "'\"`":
            i = _skip_js_string(src, i)
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
            if depth == 0 and c == ")":
                return i
        i += 1
    return -1


def _iter_calls(src: str, fn_name: str):
    """Yield the raw argument-list text of every `fn_name(...)` call site."""
    needle = fn_name + "("
    start = 0
    while True:
        idx = src.find(needle, start)
        if idx == -1:
            return
        open_idx = idx + len(fn_name)
        close_idx = _find_matching_paren(src, open_idx)
        if close_idx == -1:
            return
        yield src[open_idx + 1:close_idx]
        start = close_idx + 1


def _split_top_level(arglist: str) -> list[str]:
    """Split a JS argument list on commas at bracket/quote depth 0."""
    parts, cur, depth, i, n = [], [], 0, 0, len(arglist)
    while i < n:
        c = arglist[i]
        if c in "'\"`":
            j = _skip_js_string(arglist, i)
            cur.append(arglist[i:j])
            i = j
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        if c == "," and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(c)
        i += 1
    parts.append("".join(cur))
    return [p.strip() for p in parts]


_JS_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\",
               "'": "'", '"': '"', "`": "`", "$": "$"}


def _decode_js_string(raw: str) -> str | None:
    """Decode a single JS string literal, quotes included. `\\\\` collapses to
    one backslash first, the same as the JS engine that would otherwise run
    this — which matters here because a LaTeX command in these pages is always
    written `\\\\command` in source (one JS-escaped backslash) precisely so it
    does NOT collapse; see packages/kit/lib/shell.js on collapsed escapes."""
    raw = raw.strip()
    if not raw or raw[0] not in "'\"`":
        return None
    quote = raw[0]
    body = raw[1:-1] if raw.endswith(quote) and len(raw) >= 2 else raw[1:]
    out, i, n = [], 0, len(body)
    while i < n:
        c = body[i]
        if c == "\\" and i + 1 < n:
            nxt = body[i + 1]
            out.append(_JS_ESCAPES.get(nxt, "\\" + nxt))
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _clean_text(s: str | None) -> str:
    if not s:
        return ""
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _string_field(obj_src: str, key: str) -> str | None:
    m = re.search(r"\b" + re.escape(key) + r"\s*:\s*", obj_src)
    if not m or m.end() >= len(obj_src) or obj_src[m.end()] not in "'\"`":
        return None
    j = _skip_js_string(obj_src, m.end())
    return _decode_js_string(obj_src[m.end():j])


def _int_list_field(obj_src: str, key: str) -> list[int]:
    m = re.search(r"\b" + re.escape(key) + r"\s*:\s*\[([^\]]*)\]", obj_src)
    if not m:
        return []
    out = []
    for tok in m.group(1).split(","):
        tok = tok.strip()
        if tok.lstrip("-").isdigit():
            out.append(int(tok))
    return out


def extract_page_context(html: str) -> dict:
    """Pull setup / steps (text, why, uses) / answers (label, value, sanity)
    out of a generated page's source. Best-effort: a call this cannot parse is
    just missing from the result rather than a crash — better a thinner
    context for the tutor than a 500 for the student."""
    setup = None
    for arglist in _iter_calls(html, "Shell.setup"):
        args = _split_top_level(arglist)
        if args:
            setup = _clean_text(_decode_js_string(args[0]))
        break

    steps = []
    for arglist in _iter_calls(html, "Shell.step"):
        args = _split_top_level(arglist)
        if not args:
            continue
        text = _clean_text(_decode_js_string(args[0]))
        opts = args[1] if len(args) > 1 else ""
        steps.append({
            "n": len(steps) + 1,
            "text": text,
            "why": _clean_text(_string_field(opts, "why")) or None,
            "uses": _int_list_field(opts, "uses"),
        })

    answers = []
    for arglist in _iter_calls(html, "Shell.answer"):
        args = _split_top_level(arglist)
        if len(args) < 2:
            continue
        opts = args[2] if len(args) > 2 else ""
        answers.append({
            "label": _clean_text(_decode_js_string(args[0])),
            "value": _clean_text(_decode_js_string(args[1])),
            "sanity": _clean_text(_string_field(opts, "sanity")) or None,
        })

    return {"setup": setup, "steps": steps, "answers": answers}


def _format_page_context(problem_text: str, ctx: dict) -> str:
    lines = []
    if problem_text:
        lines.append(f"โจทย์: {problem_text}")
    if ctx.get("setup"):
        lines.append(f"แนวทาง: {ctx['setup']}")
    for s in ctx.get("steps", []):
        line = f"ขั้นที่ {s['n']}: {s['text']}"
        if s.get("why"):
            line += f"\n  เหตุผล: {s['why']}"
        if s.get("uses"):
            line += "\n  อ้างอิงขั้นที่: " + ", ".join(str(u) for u in s["uses"])
        lines.append(line)
    for a in ctx.get("answers", []):
        line = f"คำตอบ: {a.get('label', '')} = {a.get('value', '')}"
        if a.get("sanity"):
            line += f"\n  การตรวจคำตอบ: {a['sanity']}"
        lines.append(line)
    return "\n".join(lines) if lines else "(หน้านี้ไม่มีเนื้อหาขั้นตอนให้ใช้)"


TUTOR_SYSTEM_PROMPT = """คุณคือ "ติวเตอร์" ที่ตอบคำถามของนักเรียนเกี่ยวกับหน้าโจทย์หนึ่งหน้าเท่านั้น
หน้านี้ผ่านการตรวจสอบและได้รับการอนุมัติจากครูแล้ว ส่วนคำถามของนักเรียนที่คุณกำลังตอบยังไม่ผ่านการตรวจจากใครเลย
ดังนั้นเนื้อหาของหน้าที่อนุมัติแล้วซึ่งให้ไว้ด้านล่างคือแหล่งความจริงเพียงแหล่งเดียวที่คุณใช้ได้ ไม่ใช่ความรู้ทั่วไปของคุณ และไม่ใช่วิธีทำแบบอื่นที่คุณคิดว่าถูกต้องกว่า

กติกาที่ต้องทำตามอย่างเคร่งครัด:
- ห้ามคิดคำตอบ วิธีทำ หรือคำนวณใหม่ด้วยตัวเอง ให้ใช้เฉพาะขั้นตอน เหตุผล (why) และคำตอบที่ปรากฏอยู่ในหน้านี้เท่านั้น เพราะครูตรวจสอบเฉพาะหน้านี้ ไม่ได้ตรวจสอบคำตอบที่คุณจะแต่งขึ้นใหม่
- ถ้าคำถามถามถึงสิ่งที่หน้านี้ไม่ได้ครอบคลุม (เช่น วิธีทำแบบอื่น ขั้นตอนที่ไม่มีอยู่ หรือโจทย์ข้ออื่น) ให้บอกนักเรียนตรงๆ ว่าหน้านี้ไม่ได้ครอบคลุมเรื่องนั้น แล้วหยุดแค่นั้น อย่าแต่งคำตอบขึ้นมาเอง
- ทุกครั้งที่อ้างอิงเนื้อหาจากขั้นตอนใด ให้ใส่หมายเลขขั้นตอนนั้นลงใน "cites" เพื่อให้นักเรียนย้อนกลับไปตรวจสอบกับสิ่งที่ครูอนุมัติได้เอง ถ้าไม่ได้อ้างอิงขั้นตอนใดเลยให้ cites เป็นลิสต์ว่าง
- ตอบเป็นภาษาไทย กระชับ ชัดเจน เหมาะกับระดับมัธยมปลาย

ตอบกลับเป็น JSON เท่านั้น รูปแบบ: {"answer": "<คำตอบของคุณ>", "cites": [<หมายเลขขั้นตอนที่อ้างอิง>]}
ห้ามมีข้อความใดๆ นอกเหนือจากก้อน JSON นี้"""


def ask_tutor(problem_text: str, ctx: dict, question: str) -> dict:
    """One call, JSON-mode, parsed with json.loads only — never eval()/
    sympify() on anything the model returns."""
    client = genai_client()
    user_text = f"{_format_page_context(problem_text, ctx)}\n\nคำถามของนักเรียน: {question}"
    config = types.GenerateContentConfig(
        max_output_tokens=2048,
        system_instruction=TUTOR_SYSTEM_PROMPT,
        response_mime_type="application/json",
        safety_settings=_safety_off(),
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        thinking_config=types.ThinkingConfig(thinking_level="LOW"),
    )
    contents = [types.Content(role="user", parts=[types.Part.from_text(text=user_text)])]

    def call():
        return client.models.generate_content(model=MODEL, contents=contents, config=config)

    resp = _retry_transient(call)
    raw = (resp.text or "").strip()
    valid_ns = {s["n"] for s in ctx.get("steps", [])}
    answer, cites = "", []
    try:
        data = json.loads(raw)
        answer = str(data.get("answer") or "").strip()
        cites = sorted({
            int(c) for c in (data.get("cites") or [])
            if isinstance(c, (int, float)) and int(c) in valid_ns
        })
    except (json.JSONDecodeError, TypeError, ValueError, AttributeError):
        answer = ""
    if not answer:
        answer = raw or "ขออภัย ระบบไม่สามารถตอบคำถามนี้ได้ในขณะนี้ ลองใหม่อีกครั้ง"
    return {"answer": answer, "cites": cites}


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

    # Image-sourced problems arrive with no text at all — see
    # apps/api/app/main.py: add_problem_image(). Restate before anything else
    # so run_generate() below sees exactly the same shape of input it already
    # gets from the text endpoint (problem.extracted_text or .raw_text).
    if problem.source == "image" and not (problem.extracted_text or "").strip():
        problem.extracted_text = restate_image(problem, db, job)
        db.commit()

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

    # Land the finished draft at the storage root. Nothing serves this volume —
    # see the module docstring — so this is not "publishing" it anywhere; it is
    # just where review_page() will look for it if a teacher approves it.
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


def handle_tutor_ask(db, job: Job) -> None:
    """POST /pages/{page_id}/ask (apps/api/app/main.py) creates this job with
    target_id=page_id and progress_json={"question": ...}, then polls for
    state in (done, failed) and answers the HTTP request from whatever this
    writes back into progress_json. Context comes ONLY from the approved
    page's own stored HTML — never from a fresh solve — and 409s (the page is
    not approved) are caught by the API before this job is even created, but
    are re-checked here too since a page could be rejected while a chat job
    sits queued behind a page generation."""
    page = db.get(Page, job.target_id)
    if page is None:
        raise RuntimeError(f"page {job.target_id} is gone")
    if page.status != "approved":
        raise RuntimeError("page is not approved")
    question = ((job.progress_json or {}).get("question") or "").strip()
    if not question:
        raise RuntimeError("no question given")
    if not page.html_path:
        raise RuntimeError("page has no stored html")
    html_file = STORAGE / page.html_path
    if not html_file.exists():
        raise RuntimeError(f"page html missing from storage: {html_file}")

    set_stage(db, job, "answering")
    html = html_file.read_text(encoding="utf-8", errors="replace")
    ctx = extract_page_context(html)
    problem = db.get(Problem, page.problem_id)
    problem_text = ((problem.extracted_text if problem else None)
                     or (problem.raw_text if problem else None) or "").strip()

    result = ask_tutor(problem_text, ctx, question)
    set_stage(db, job, "done", answer=result["answer"], cites=result["cites"])


def claim_one(db) -> Job | None:
    """Single worker, so a plain SELECT is honest. With more than one this
    wants SKIP LOCKED — noted here rather than pretended.

    tutor_ask jumps the queue ahead of generate/recheck: the API answers a
    chat question synchronously from inside one HTTP request (see
    apps/api/app/main.py: ask_page()), and a generate job already queued
    ahead of it can take 30-90 seconds — long enough to blow past any
    reasonable answer timeout if chat waited its ordinary turn. This only
    reorders the QUEUE; a job already RUNNING still has to finish first."""
    job = (
        db.query(Job)
        .filter(Job.state == "queued")
        .order_by((Job.kind != "tutor_ask"), Job.created_at.asc())
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
                elif job.kind == "tutor_ask":
                    handle_tutor_ask(db, job)
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
