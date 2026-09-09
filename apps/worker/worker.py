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

Three more job kinds live here, added for student/teacher-facing features
below. `tutor_ask` calls the model directly with google-genai — there is
nothing in kit/ for it to wrap. `revise` shells out to kit/generate.py same
as `generate` does, just in a different mode:

`generate` on an image-sourced problem hands the photograph straight to
kit/generate.py via --image. There is no OCR step and no separate restatement
call: the model reads the picture and writes the page in one pass, which keeps
the diagram it saw and the diagram it draws in the same head. What it understood
the problem to be is recovered afterwards from the page's own
Shell.page({problem}) call (extract_problem_statement below) and stored as
problem.extracted_text, which is what a teacher compares against the photo
before publishing.

An earlier design restated the photo to text first and generated from that
text. It is gone — going through text lost every diagram — and so is
restate_image(), which implemented it.

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

`revise` (see handle_revise() / kit/generate.py's --revise-from) fixes a page
someone already has instead of starting over — the model gets the existing
page's full HTML plus a change instruction and is told to change only what's
asked, then the same check.mjs run a fresh generation gets. It is NOT given
tutor_ask's queue-priority: a ~90s revision jumping ahead of a student's
question is exactly the starvation that priority exists to prevent. Personal
content only for now — see POST /pages/{page_id}/revise in apps/api/app/main.py
and docs/BACKLOG.md for why global content's review-gate interaction is a
separate pass, not a corner cut into this one.
"""
from __future__ import annotations

import concurrent.futures
import datetime as dt
import json
import os
import pathlib
import re
import subprocess
import sys
import threading
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

# The width of the generate/revise pool — jobs whose work is a subprocess
# mostly waiting on the model's HTTPS response (see run_generate/run_revise
# below), so this can run wide without much CPU/RAM cost per job. See
# docker-compose.yml for the memory arithmetic this number is sized against.
# 24, not the original 12: that number assumed ~130MB RSS per generate.py
# subprocess; measured live (a real call, sampled mid-flight in this image)
# it's ~45-55MB — a fresh interpreter plus google-genai, not the heavier
# stack that estimate guessed at. 24 x ~80MB (padded up from the measured
# figure for headroom at high effort's larger prompts/responses) = ~1920MB,
# still leaving real slack inside the worker's memory cap for
# CHECK_CONCURRENCY's chromiums. The still-unverified ceiling is Google's
# own per-key rate limit, not anything measured on this box — see
# docs/BACKLOG.md before raising this further.
MAX_WORKERS = int(os.environ.get("WORKER_CONCURRENCY", "24"))
# tutor_ask never spawns a subprocess (handle_tutor_ask calls google-genai
# in-process) and costs ~0 RAM per thread, but before this pool existed it
# still had to wait for a MAX_WORKERS slot alongside every generate/revise
# job — claim_one() gave it queue priority, not a slot of its own, so a chat
# question could still sit behind a 60-90s generation and hit
# ASK_TIMEOUT_SECONDS (apps/api/app/main.py). A separate small pool fully
# decouples chat latency from generation queue depth.
TUTOR_WORKERS = int(os.environ.get("TUTOR_CONCURRENCY", "4"))
# NOT a second thread pool — see _check_gate below for why this stays a
# semaphore around one call site instead.
CHECK_WORKERS = int(os.environ.get("CHECK_CONCURRENCY", "2"))

# kit/generate.py's own --timeout (its HTTP client timeout, default 420s)
# must stay well inside this subprocess timeout, or a single hung attempt
# burns the whole budget and call_with_backoff's multi-attempt retry ladder
# never gets to run — the worker kills a job that was legitimately retrying
# a transient 429/503 instead of letting the backoff succeed.
GENERATE_TIMEOUT_SECONDS = int(os.environ.get("GENERATE_TIMEOUT_SECONDS", "900"))
GENERATE_CALL_TIMEOUT = int(os.environ.get("GENERATE_CALL_TIMEOUT", "180"))
CHECK_TIMEOUT_SECONDS = int(os.environ.get("CHECK_TIMEOUT_SECONDS", "300"))
POLL_SECONDS = 2

# Chromium is the one genuinely CPU/RAM-expensive step here (~300MB RSS and
# real render work per instance), unlike generate.py's subprocess which
# mostly just waits on the network. Gating it with its own narrow semaphore
# — rather than sizing MAX_WORKERS down to match, or running a second
# ThreadPoolExecutor — lets the wide, network-bound generate phase run at
# full MAX_WORKERS width while only ever CHECK_WORKERS browsers are alive at
# once. A second pool was rejected: splitting process_job() across pools
# would mean handing a SQLAlchemy Session across threads (unsafe) or
# reopening one mid-job, for a property ("never more than N chromiums") a
# semaphore around the one subprocess.run call already gives for free. A job
# waiting on this semaphore still holds a generate-pool thread, but its
# generate.py child has already exited by then, so that thread costs ~0MB
# while it waits.
_check_gate = threading.Semaphore(CHECK_WORKERS)

# The kit's own vocabulary (packages/kit/generate.py's EFFORT dict) for the
# one call here that talks to google-genai directly instead of shelling out
# to that script — ask_tutor(). generate.py validates its own --effort
# argument against its own copy of this map; this one only has to match it.
THINKING_LEVEL = {"low": "LOW", "medium": "MEDIUM", "high": "HIGH"}


def job_effort(job: Job, default: str) -> str:
    """The effort a job's own request asked for (apps/api/app/main.py
    validates it into progress_json before this ever runs), falling back to
    `default` when the request didn't specify one. Never trusts an unknown
    value even though the API already validates — a worker reading its own
    queue should not crash a job over a row nothing here wrote."""
    eff = (job.progress_json or {}).get("effort")
    return eff if eff in THINKING_LEVEL else default


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
# ask_tutor() calls google-genai directly. It is not "generation" in the kit's
# sense — it turns an approved page into a chat answer — so routing it through
# kit/generate.py would mean teaching that script an input it was never built
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


def extract_problem_statement(html: str) -> str | None:
    """Extract the Thai problem statement passed to Shell.page({ problem: ... })
    in the generated page. Uses _decode_js_string() directly without _clean_text()
    so LaTeX math formulas, newlines, and formatting are preserved identically to JS."""
    for arglist in _iter_calls(html, "Shell.page"):
        problem_str = _string_field(arglist, "problem")
        if problem_str and problem_str.strip():
            return problem_str.strip()
    return None


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


TUTOR_SYSTEM_PROMPT = """คุณคือ "ติวเตอร์" ผู้เชี่ยวชาญด้านคณิตศาสตร์และฟิสิกส์ ที่คอยช่วยเหลือนักเรียนในการทำความเข้าใจโจทย์และเฉลยวิธีทำในหน้านี้
หน้าที่ของคุณคืออธิบาย ชี้แนะ และตอบทุกคำถามของนักเรียนอย่างเป็นกันเอง ชัดเจน ตรงจุด และถูกต้องตามหลักวิชาการ

แนวทางการตอบคำถาม:
- อธิบายและขยายความ: อธิบายขั้นตอน วิธีคิด ที่มาของสูตร และเหตุผล (why) ในหน้านี้เพื่อให้นักเรียนเข้าใจอย่างลึกซึ้ง
- ตอบคำถามกรณีสมมติ (What-if): หากนักเรียนถามกรณีเปลี่ยนตัวเลข เงื่อนไข หรือสถานการณ์ (เช่น "ถ้าระยะเป็น 150m ล่ะ", "ถ้าไม่มีความเสียดทานล่ะ") ให้คิดคำนวณและอธิบายผลลัพธ์ใหม่ให้นักเรียนเห็นอย่างชัดเจน โดยเปรียบเทียบกับวิธีในหน้านี้
- เสนอวิธีทำหรือสูตรทางเลือก: หากนักเรียนถามว่ามีสูตรอื่น วิธีคิดอื่น หรือรูปสมการแบบอื่นไหม ให้ยินดีอธิบายและแสดงวิธีคิดทางเลือกให้ดู พร้อมชี้ให้เห็นความเชื่อมโยงกับวิธีในหน้านี้
- อธิบายหลักการและทฤษฎีพื้นฐาน: ตอบคำถามเกี่ยวกับนิยาม สูตร หรือมโนทัศน์ทางคณิตศาสตร์/ฟิสิกส์ที่เกี่ยวข้องได้เต็มที่ ไม่จำกัดอยู่แค่ตัวหนังสือในหน้านี้
- การอ้างอิงขั้นตอน (cites):
  * หากคำตอบเกี่ยวข้องหรืออ้างอิงขั้นตอนใดในหน้านี้ ให้ใส่หมายเลขขั้นนั้นในลิสต์ "cites" (เช่น [1], [2, 3]) เพื่อให้นักเรียนคลิกดูขั้นตอนประกอบได้
  * หากเป็นคำถามความรู้ทั่วไป วิธีคิดทางเลือก หรือกรณีตัวเลขสมมติที่ไม่มีขั้นตอนตรงๆ ในหน้านี้ ให้ใส่ cites เป็นลิสต์ว่าง []
- ภาษาและรูปแบบ: สุภาพ เป็นมิตร กระชับ เหมาะกับนักเรียนระดับมัธยมปลาย ใช้สัญลักษณ์คณิตศาสตร์/ฟิสิกส์ในรูปแบบ LaTeX ($...$ หรือ $$...$$) เพื่อความชัดเจน

ตอบกลับเป็น JSON เท่านั้น รูปแบบ: {"answer": "<คำตอบของคุณ>", "cites": [<หมายเลขขั้นตอนที่อ้างอิง>]}
ห้ามมีข้อความใดๆ นอกเหนือจากก้อน JSON นี้"""


def ask_tutor(problem_text: str, ctx: dict, question: str, effort: str = "low") -> dict:
    """One call, JSON-mode, parsed with json.loads only — never eval()/
    sympify() on anything the model returns. `effort` defaults to low: a
    question answered strictly from stored page text (TUTOR_SYSTEM_PROMPT
    forbids anything else) is not a reasoning-heavy task, and low is what
    this always ran at before effort became choosable per request."""
    client = genai_client()
    user_text = f"{_format_page_context(problem_text, ctx)}\n\nคำถามของนักเรียน: {question}"
    config = types.GenerateContentConfig(
        max_output_tokens=2048,
        system_instruction=TUTOR_SYSTEM_PROMPT,
        response_mime_type="application/json",
        safety_settings=_safety_off(),
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        thinking_config=types.ThinkingConfig(thinking_level=THINKING_LEVEL.get(effort, "LOW")),
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


def run_generate(problem: Problem, out_dir: pathlib.Path, db, job: Job, effort: str) -> pathlib.Path | None:
    """One problem through generate.py. Passed directly as CLI arguments so multiline
    text statements never get split by batch line parsers. For image problems,
    the image path is passed via --image to allow direct single-call multimodal
    generation with zero diagram loss.

    `source == "variant"` is the one other branch: POST /problems/{id}/similar
    (apps/api/app/main.py) creates a Problem with no raw_text/extracted_text
    at all — the model invents the new problem statement itself — and
    `progress_json` carries which source to vary and how (source_problem_id,
    variation, steer). Reusing kind="generate" for this rather than adding a
    fourth job kind is deliberate: everything downstream of run_generate
    (check.mjs, the final filename, the Page row, the generating-card UI,
    every poll-based list endpoint) already does exactly the right thing for
    a plain "generate" job and would otherwise all need to learn a new kind."""
    is_variant = problem.source == "variant"
    text = (problem.raw_text or problem.extracted_text or "").strip()
    image_args: list[str] = []
    if problem.source == "image" and problem.image_path:
        img_p = STORAGE / problem.image_path
        if img_p.is_file():
            image_args = ["--image", str(img_p)]
        else:
            raise RuntimeError(f"problem image missing on disk: {img_p}")

    if not text and not image_args and not is_variant:
        raise RuntimeError("problem has neither text nor image")

    set_stage(db, job, "generating", model=MODEL, effort=effort)
    cmd = ["python3", str(KIT / "generate.py")]
    if is_variant:
        progress = job.progress_json or {}
        source_id = progress.get("source_problem_id")
        source = db.get(Problem, source_id) if source_id else None
        if source is None:
            raise RuntimeError(f"source problem {source_id} for variant is gone")
        source_text = (source.extracted_text or source.raw_text or "").strip()
        if not source_text:
            raise RuntimeError(f"source problem {source_id} has no text to vary")
        cmd += ["--similar-to", source_text, "--variation", progress.get("variation") or "same"]
        if progress.get("steer"):
            cmd += ["--steer", progress["steer"]]
    else:
        cmd.append(text)
    cmd += [
        "--id", problem.id,
        "--out", str(out_dir),
        "--model", MODEL,
        "--effort", effort,
        "--jobs", "1",
        "--timeout", str(GENERATE_CALL_TIMEOUT),
    ]
    if problem.level:
        cmd += ["--level", problem.level]
    if image_args:
        cmd += image_args

    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=GENERATE_TIMEOUT_SECONDS)
    log(proc.stdout[-2000:])
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout)[-500:])

    page_file = out_dir / "pages" / f"{problem.id}.html"
    return page_file if page_file.is_file() else None


def run_revise(problem: Problem, source_html: pathlib.Path, instruction: str,
               out_dir: pathlib.Path, db, job: Job, effort: str) -> pathlib.Path | None:
    """A problem's existing page through generate.py's --revise-from mode
    instead of a from-scratch one — see that script's build_revise_prompt().
    Same id-and-directory shape as run_generate so run_check() below needs no
    branching between the two; the pid just happens not to match any file
    that will ever be written outside this one run directory."""
    pid = f"{problem.id}-revise-{job.id}"
    image_args: list[str] = []
    if problem.source == "image" and problem.image_path:
        img_p = STORAGE / problem.image_path
        if img_p.is_file():
            image_args = ["--image", str(img_p)]
        # Unlike run_generate, a missing photo here is not fatal: the
        # existing page's own HTML (already read in full) is still enough
        # context for a revision, whereas a from-scratch generation with no
        # image and no text has nothing to work from at all.

    set_stage(db, job, "revising", model=MODEL, effort=effort)
    cmd = [
        "python3", str(KIT / "generate.py"),
        "--revise-from", str(source_html),
        "--instruction", instruction,
        "--id", pid,
        "--out", str(out_dir),
        "--model", MODEL,
        "--effort", effort,
        "--jobs", "1",
        "--timeout", str(GENERATE_CALL_TIMEOUT),
    ]
    cmd += image_args

    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=GENERATE_TIMEOUT_SECONDS)
    log(proc.stdout[-2000:])
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout)[-500:])

    page_file = out_dir / "pages" / f"{pid}.html"
    return page_file if page_file.is_file() else None


def run_check(page_file: pathlib.Path, db, job: Job) -> dict | None:
    """check.mjs --json gives exactly the row the review screen reads. The app
    cannot read anything out of the page itself — it is embedded in an
    opaque-origin sandbox on purpose — so the report has to be produced here."""
    set_stage(db, job, "checking")
    out = page_file.parent.parent / "checks.json"
    cmd = ["node", str(KIT / "checks" / "check.mjs"), "--json", str(out), str(page_file)]
    # Held for the queued time too, deliberately: this thread's generate.py
    # child has already exited by the time run_check runs, so waiting here
    # costs ~0MB — see _check_gate's docstring for why this is a semaphore
    # around one call site rather than a second thread pool.
    with _check_gate:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=CHECK_TIMEOUT_SECONDS)
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

    effort = job_effort(job, default=EFFORT)
    work = STORAGE / "runs" / job.id
    work.mkdir(parents=True, exist_ok=True)

    page_file = run_generate(problem, work, db, job, effort)
    if page_file is None:
        raise RuntimeError("generate produced no page")

    checks = run_check(page_file, db, job)
    html = page_file.read_text(encoding="utf-8", errors="replace")

    # If this problem was image-sourced OR is a generated variant, extract the
    # problem statement the generator itself wrote into the page's
    # Shell.page({problem}) call, and save it to problem.extracted_text —
    # both cases share the same situation: the caller never typed the
    # problem, so this call is the ONLY record of what it actually is.
    if problem.source in ("image", "variant"):
        extracted = extract_problem_statement(html)
        if extracted:
            problem.extracted_text = extracted
            db.commit()
        elif problem.raw_text:
            problem.extracted_text = problem.raw_text
            db.commit()

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
        effort=effort,
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
    writes back into progress_json. Context comes ONLY from the page's own
    stored HTML — never from a fresh solve.

    The access rule is re-checked here, not just trusted from the API, since
    a page's state — or, for personal content, who the asker even was —
    could have been true when ask_page() queued this job and not be true any
    more by the time a job sits behind a generation and actually runs. It has
    to match main.py's _page_visible() exactly: global content needs
    `approved` (the review gate); personal content has no review gate at all
    (see models.py's Review docstring) and needs `ready` AND that the asker
    (job.requested_by) still owns it — ownership is the one thing a
    status-only re-check cannot see, which is why the check is on the job's
    requester and not just on the page."""
    page = db.get(Page, job.target_id)
    if page is None:
        raise RuntimeError(f"page {job.target_id} is gone")
    problem = db.get(Problem, page.problem_id) if page.problem_id else None
    is_personal_ready = (
        problem is not None
        and problem.scope == "personal"
        and problem.owner_id == job.requested_by
        and page.status == "ready"
    )
    if page.status != "approved" and not is_personal_ready:
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

    result = ask_tutor(problem_text, ctx, question, job_effort(job, default="low"))
    set_stage(db, job, "done", answer=result["answer"], cites=result["cites"])


def handle_revise(db, job: Job) -> None:
    """POST /pages/{page_id}/revise (apps/api/app/main.py) creates this job
    with target_id=page_id and progress_json={instruction, effort,
    problem_id}. Same re-check structure as handle_tutor_ask and for the same
    reason: whatever main.py verified when it queued this job is a claim
    about that moment, not about now.

    Personal content only, matching the endpoint — see this function's
    reasoning for why global revision isn't offered yet. The endpoint's own
    guards (current page, no other live version, no in-flight job, chain
    depth) are trusted here for cost — this only re-checks the two things
    that can actually go stale between queueing and running: who's allowed to
    see the result, and whether the source is still the current page."""
    page = db.get(Page, job.target_id)
    if page is None:
        raise RuntimeError(f"page {job.target_id} is gone")
    problem = db.get(Problem, page.problem_id) if page.problem_id else None
    if problem is None or problem.scope != "personal" or problem.owner_id != job.requested_by:
        raise RuntimeError("revising this page is not allowed")
    if page.superseded_by is not None:
        raise RuntimeError("a newer version of this page already exists")
    instruction = ((job.progress_json or {}).get("instruction") or "").strip()
    if not instruction:
        raise RuntimeError("no instruction given")
    if not page.html_path:
        raise RuntimeError("page has no stored html")
    source_html = STORAGE / page.html_path
    if not source_html.exists():
        # Never fall through to a from-scratch generation instead — the same
        # reasoning as kit/generate.py's read_image() docstring: a run that
        # silently does something other than what was asked, while still
        # reporting success, is the worst available outcome.
        raise RuntimeError(f"page html missing from storage: {source_html}")

    effort = job_effort(job, default=page.effort or EFFORT)
    work = STORAGE / "runs" / job.id
    work.mkdir(parents=True, exist_ok=True)

    page_file = run_revise(problem, source_html, instruction, work, db, job, effort)
    if page_file is None:
        raise RuntimeError("revise produced no page")

    checks = run_check(page_file, db, job)
    html = page_file.read_text(encoding="utf-8", errors="replace")

    # Distinct filename, deliberately never problem.id.html: every generated
    # page for a problem used to land on the exact same name, which would
    # make a revision clobber the file the current page's own tutor chat and
    # /drafts/ serving still read, and would make rejecting a bad revision of
    # an approved page (once that exists — see docs/BACKLOG.md) delete the
    # live published file out from under it.
    n = db.query(Page).filter(Page.problem_id == problem.id).count()
    final_name = f"{problem.id}-r{n}.html"
    final = STORAGE / final_name
    final.write_bytes(page_file.read_bytes())

    new_page = Page(
        problem_id=problem.id,
        kit_version=kit_version(),
        model=MODEL,
        effort=effort,
        html_path=final_name,
        path_chosen="board" if "Shell.board(" in html else "svg",
        checks_json=checks,
        status="ready",
    )
    db.add(new_page)
    db.flush()  # need new_page.id both for superseded_by and the SSE payload

    # Currency transfers now, unconditionally, for personal content — it has
    # no review gate at all (models.py's Review docstring), so `ready` is
    # already as far as "done" gets, same as a fresh generation. Global
    # content's approved case defers this (see docs/BACKLOG.md); unreachable
    # here since this endpoint refuses non-personal content.
    page.superseded_by = new_page.id
    set_stage(db, job, "done", page_id=new_page.id)


def claim_one(db, kinds: tuple[str, ...]) -> Job | None:
    """Claim the next queued job of one of `kinds`.
    Uses SELECT ... FOR UPDATE SKIP LOCKED so concurrent worker threads and scaled
    worker replicas never race or double-claim the same job row.
    tutor_ask jumps ahead of generate/revise so chat questions are answered
    immediately when both kinds are being claimed for (kept even though
    main() now also gives tutor_ask its own pool, since a still-warm
    generate-pool slot should not claim a tutor_ask ahead of the pool meant
    for it, and vice versa — `kinds` is what actually prevents that, this
    ordering is just belt-and-braces within one call)."""
    job = (
        db.query(Job)
        .filter(Job.state == "queued", Job.kind.in_(kinds))
        .order_by((Job.kind != "tutor_ask"), Job.created_at.asc())
        .with_for_update(skip_locked=True)
        .first()
    )
    if job is None:
        return None
    job.state = "running"
    job.attempts += 1
    job.started_at = dt.datetime.now(dt.timezone.utc)
    db.commit()
    return job


def process_job(job_id: str) -> None:
    """Execute one claimed job in its own isolated database session."""
    db = SessionLocal()
    try:
        job = db.get(Job, job_id)
        if job is None:
            return
        log(f"worker: job {job.id} {job.kind} -> {job.target_id}")
        try:
            if job.kind == "generate":
                handle_generate(db, job)
            elif job.kind == "tutor_ask":
                handle_tutor_ask(db, job)
            elif job.kind == "revise":
                handle_revise(db, job)
            else:
                raise RuntimeError(f"unknown job kind {job.kind}")
            job.state = "done"
        except Exception as e:  # noqa: BLE001 - a failed job must not kill the worker
            log(f"worker: job {job.id} failed: {e}")
            job.state = "failed"
            job.error = str(e)[:2000]
            set_stage(db, job, "failed", error=str(e)[:500])
        job.finished_at = dt.datetime.now(dt.timezone.utc)
        db.commit()
    finally:
        db.close()


def recover_orphaned_jobs(db) -> None:
    """Jobs that were marked 'running' when the worker previously crashed or
    was restarted will never finish unless reset. Re-queue them on startup if
    they haven't exceeded max retries, or mark them failed."""
    orphans = db.query(Job).filter(Job.state == "running").all()
    for job in orphans:
        if job.attempts < 3:
            log(f"worker: recovering interrupted job {job.id} (attempt {job.attempts}) -> queued")
            job.state = "queued"
            job.stage = "queued"
        else:
            log(f"worker: failing exhausted job {job.id}")
            job.state = "failed"
            job.stage = "failed"
            job.error = "worker restarted while job was running"
            job.finished_at = dt.datetime.now(dt.timezone.utc)
    if orphans:
        db.commit()


def main() -> None:
    init_db()
    log(f"worker: up. kit={kit_version()} model={MODEL} effort={EFFORT} "
        f"concurrency={MAX_WORKERS} tutor_concurrency={TUTOR_WORKERS} check_concurrency={CHECK_WORKERS}")
    db_init = SessionLocal()
    try:
        recover_orphaned_jobs(db_init)
    finally:
        db_init.close()

    # Two pools, not one: tutor_ask never spawns a subprocess and previously
    # only got queue PRIORITY (claim_one's ordering) over generate/revise, not
    # a slot of its own — with every MAX_WORKERS slot busy on real
    # generations, a chat question still waited behind one. See TUTOR_WORKERS
    # above.
    gen_pool = concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS)
    tutor_pool = concurrent.futures.ThreadPoolExecutor(max_workers=TUTOR_WORKERS)
    gen_futures: set[concurrent.futures.Future] = set()
    tutor_futures: set[concurrent.futures.Future] = set()

    while True:
        for futures in (gen_futures, tutor_futures):
            done_futures = {f for f in futures if f.done()}
            for f in done_futures:
                try:
                    f.result()
                except Exception as exc:
                    log(f"worker: unexpected error in worker thread: {exc}")
            futures -= done_futures

        kinds: list[str] = []
        if len(gen_futures) < MAX_WORKERS:
            kinds += ["generate", "revise"]
        if len(tutor_futures) < TUTOR_WORKERS:
            kinds.append("tutor_ask")

        claimed = False
        if kinds:
            db = SessionLocal()
            try:
                job = claim_one(db, tuple(kinds))
                if job:
                    if job.kind == "tutor_ask":
                        tutor_futures.add(tutor_pool.submit(process_job, job.id))
                    else:
                        gen_futures.add(gen_pool.submit(process_job, job.id))
                    claimed = True
            finally:
                db.close()

        if not claimed:
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
