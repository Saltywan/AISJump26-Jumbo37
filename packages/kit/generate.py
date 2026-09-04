# /// script
# requires-python = ">=3.10"
# dependencies = ["google-genai>=1.0"]
# ///
"""Generate JumpAIS solution pages from problem statements.

    uv run kit/generate.py "จงหาพื้นที่ของบริเวณที่ปิดล้อมด้วย $y=4-x^2$ และ $y=x+2$"
    uv run kit/generate.py -f problems.txt --check
    uv run kit/generate.py "โจทย์..." --level ม.6 --effort high --label my-run

Assembles exactly the same prompt as `checks/run.sh` — the one-line role header
from prompts/poc-original.th.txt, the problem, then prompts/shell-rules.th.txt
verbatim — so pages made here are comparable with every archived run.

Everything is kept: the prompt sent, the raw model output, the finished page.
Two of the defects fixed in the shell were only diagnosable by reading what the
model actually emitted next to what rendered, so the raw text is not throwaway.

Needs GOOGLE_CLOUD_API_KEY, read from the project's .env (or the environment).
--model can also name an OpenRouter slug (anything containing "/", e.g.
openai/gpt-5.6-terra) to route through OpenRouter instead of Gemini; that
path needs OPENROUTER_API_KEY, read the same way.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import os
import random
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# Deferred so that --help still works on a machine that has not installed the SDK
# yet, and so the failure is one actionable line instead of a traceback. This
# bundle gets handed to people; the first thing they run should not look broken.
try:
    from google import genai
    from google.genai import types
except ImportError:                                       # pragma: no cover
    genai = types = None

# This file runs from two places and must not be forked to do it: in the repo at
# kit/generate.py, and at the root of a standalone demo bundle beside lib/ and
# prompts/. Everything is located relative to the script, and the two things that
# only exist in the repo — the spikes archive and the Node checker — are treated
# as optional rather than assumed.
HERE = Path(__file__).resolve().parent
REPO = HERE.parent

EFFORT = {"low": "LOW", "medium": "MEDIUM", "high": "HIGH"}

CHECKER = HERE / "checks" / "check.mjs"
# The animation probe is a second, deliberately separate script: folding a
# metric into check.mjs has silently blinded it before. It still has to RUN,
# though — a metric nothing invokes protects nothing.
MOTION = HERE / "checks" / "motion-density.mjs"
STANDALONE = not CHECKER.is_file()


def runs_root() -> Path:
    """Archive into the spikes tree when it is there, next to the script when not."""
    archive = REPO / "spikes" / "boardtest" / "runs"
    return archive if archive.parent.is_dir() else HERE / "runs"


# --------------------------------------------------------------------------- env
def load_env() -> None:
    """Minimal .env reader — not worth a dependency, and it never logs a value."""
    for candidate in (REPO / ".env", HERE / ".env"):
        if not candidate.is_file():
            continue
        for line in candidate.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip("'\""))


# ------------------------------------------------------------------------ prompt
def build_prompt(problem: str, level: str | None) -> str:
    header = (HERE / "prompts" / "poc-original.th.txt").read_text(
        encoding="utf-8"
    ).splitlines()[0]
    rules = (HERE / "prompts" / "shell-rules.th.txt").read_text(encoding="utf-8")
    parts = [header, "", "โจทย์:", problem.strip()]
    if level:
        parts.append(f"ระดับชั้น: {level}")
    return "\n".join(parts) + "\n" + rules


def strip_fences(text: str) -> str:
    """The model sometimes wraps the file in a markdown fence. Drop fence lines.
    Strip leading whitespace before matching: an OpenRouter model (deepseek-v4-
    flash-0731) emitted " ```html" with a leading space, which slipped past a
    bare startswith() check, left the fence line ahead of <!DOCTYPE>, and put
    the whole page in quirks mode -- which silently disables KaTeX. Every
    formula on the page rendered as nothing, and nothing else here caught it."""
    return "\n".join(l for l in text.splitlines() if not l.strip().startswith("```"))


def looks_complete(html: str) -> bool:
    """Truncated generations have happened before and are silently broken pages."""
    return "</html>" in html[-400:] and "<!DOCTYPE" in html[:200].upper().replace(
        "<!DOCTYPE", "<!DOCTYPE"
    )


OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


class OpenRouterClient:
    """Stand-in for genai.Client on the OpenRouter path. Deliberately tiny —
    it exists so call_with_backoff/generate_one keep one shared signature
    instead of forking the retry loop per backend."""

    def __init__(self, api_key: str, timeout: int, provider: str | None = None) -> None:
        self.api_key = api_key
        self.timeout = timeout
        self.provider = (
            {"order": [provider], "allow_fallbacks": False}
            if provider
            else {"sort": "throughput", "allow_fallbacks": True}
        )


def is_openrouter_model(model: str) -> bool:
    """OpenRouter slugs are always "<provider>/<model>"; none of the Gemini
    names this script has ever taken as --model contain a slash. That one
    character is enough to route without a separate flag the caller has to
    remember to pass."""
    return "/" in model


def generate_one_openrouter(client: "OpenRouterClient", model: str, prompt: str,
                            effort: str) -> str:
    # OpenRouter's unified `reasoning.effort` accepts low/medium/high directly
    # and is documented to be ignored by models that don't support reasoning
    # controls, so it is safe to send unconditionally across a mixed roster.
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 65535,
        "reasoning": {"effort": effort},
        # Most of these slugs are served by several upstreams — minimax-m3 by
        # eleven — and a page lost to one saturated or flaky provider is not a
        # verdict on the model. By default sort by throughput and let OpenRouter
        # fall back, so a slow or refusing upstream is routed around rather than
        # retried into. --provider pins a named one instead, which is how you
        # compare a model against its own first-party endpoint rather than
        # against whichever reseller happened to answer. None of this helps a
        # single-endpoint model: qwen3.8-flash is served only by Alibaba, so its
        # shared-pool 429s need a BYOK key, not routing.
        "provider": client.provider,
    }
    req = urllib.request.Request(
        OPENROUTER_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {client.api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=client.timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # Fold the status code and body into the message text, not just the
        # exception type, because call_with_backoff's transient check greps
        # the string for "429"/"503" — same contract the Google path relies on.
        detail = exc.read().decode("utf-8", "ignore")[:2000]
        # A provider that tells us how long to wait is worth listening to;
        # guessing an exponential backoff against a shared upstream pool is how
        # qwen burned six retries and still lost its problem.
        hint = exc.headers.get("Retry-After") if exc.headers else None
        suffix = f" [retry-after={hint}]" if hint else ""
        raise RuntimeError(f"HTTP {exc.code} from OpenRouter: {detail}{suffix}") from None
    except urllib.error.URLError as exc:
        raise RuntimeError(f"OpenRouter request failed: {exc.reason}") from None

    if "error" in data:
        # Some providers return HTTP 200 with the failure embedded in the body.
        raise RuntimeError(f"OpenRouter error: {data['error']}")
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError(f"OpenRouter returned no choices: {json.dumps(data)[:500]}")
    return choices[0].get("message", {}).get("content") or ""


# --------------------------------------------------------------------------- call
def generate_one(client, model: str, prompt: str, effort: str) -> str:
    if isinstance(client, OpenRouterClient):
        return generate_one_openrouter(client, model, prompt, effort)
    config = types.GenerateContentConfig(
        max_output_tokens=65535,
        # Thai physics problems talk about collisions, projectiles and falling
        # bodies; the default filters flag that often enough to be a nuisance.
        safety_settings=[
            types.SafetySetting(category=c, threshold="OFF")
            for c in (
                "HARM_CATEGORY_HATE_SPEECH",
                "HARM_CATEGORY_DANGEROUS_CONTENT",
                "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                "HARM_CATEGORY_HARASSMENT",
            )
        ],
        # No tools on purpose. The sample call wires up google_search and
        # google_maps; a generated page must be self-contained and offline, and
        # letting web content reach a student page is both a correctness problem
        # and an injection surface. The model needs the rules, not the internet.
        # With no tools declared, automatic function calling is dead weight, and
        # leaving it on makes the SDK warn on every single call.
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        thinking_config=types.ThinkingConfig(thinking_level=EFFORT[effort]),
    )
    contents = [types.Content(role="user", parts=[types.Part(text=prompt)])]
    chunks: list[str] = []
    for chunk in client.models.generate_content_stream(
        model=model, contents=contents, config=config
    ):
        if not chunk.candidates:
            continue
        cand = chunk.candidates[0]
        if not cand.content or not cand.content.parts:
            continue
        if chunk.text:
            chunks.append(chunk.text)
    return "".join(chunks)


def call_with_backoff(client, model, prompt, effort, tries: int = 7) -> str:
    """Retry on rate limiting. A batch of six lost two problems to 429s, which is
    not a model failure — it is the pipeline declining to wait its turn. Real
    workers will meet this constantly, so the retry belongs here rather than in
    the caller."""
    for attempt in range(tries):
        try:
            out = generate_one(client, model, prompt, effort)
            # An empty completion is transient, not a verdict on the model. It
            # used to raise outside this loop, so one blank response under load
            # permanently labelled a model as failed: a 13-model comparison
            # reported two of them "returned nothing" while both, retried alone,
            # answered perfectly. A cull that mislabels working models is worse
            # than no cull.
            if not out.strip():
                raise RuntimeError("empty completion from model")
            return out
        except Exception as exc:                          # noqa: BLE001
            msg = str(exc)
            transient = ("429" in msg or "RESOURCE_EXHAUSTED" in msg
                         or "503" in msg or "UNAVAILABLE" in msg
                         # a stream that stalls past the deadline is worth another
                         # go, not a lost problem — four of sixty-eight hung
                         or "timeout" in msg.lower() or "timed out" in msg.lower()
                         or "empty completion" in msg)
            if not transient or attempt == tries - 1:
                raise
            # Honour Retry-After when the provider sent one. Otherwise back off
            # exponentially, and harder for a shared upstream pool than for a
            # local hiccup — 5s doublings top out too low to outlast one.
            m = re.search(r"\[retry-after=([0-9]+)\]", msg)
            if m:
                wait = min(120.0, float(m.group(1)) + random.uniform(0, 2))
            else:
                wait = min(90.0, (2 ** attempt) * 8 + random.uniform(0, 5))
            print(f"  transient ({msg[:60]}), waiting {wait:.0f}s then retrying")
            time.sleep(wait)
    return ""


def run_problem(client, model, effort, out: Path, pid: str,
                problem: str, level: str | None) -> dict:
    prompt = build_prompt(problem, level)
    (out / "prompts" / f"p_{pid}.txt").write_text(prompt, encoding="utf-8")

    raw = call_with_backoff(client, model, prompt, effort)
    retried = False
    if not raw.strip():
        raise RuntimeError("model returned nothing")
    html = strip_fences(raw)
    if not looks_complete(html):
        # One retry. A truncated page is not a model failure worth reporting as
        # a result — it is a page that never got to say its answer.
        retried = True
        raw = call_with_backoff(client, model, prompt, effort)
        html = strip_fences(raw)

    (out / "raw" / f"{pid}.raw").write_text(raw, encoding="utf-8")
    page = out / "pages" / f"{pid}.html"
    page.write_text(html.rstrip() + "\n", encoding="utf-8")
    return {
        "id": pid,
        "bytes": len(html),
        "complete": looks_complete(html),
        "retried": retried,
        "path": "board" if "Shell.board(" in html else "svg",
        "page": page,
    }


# --------------------------------------------------------------------------- main
def read_problems(args) -> list[tuple[str, str, str | None]]:
    if args.file:
        rows = []
        for line in Path(args.file).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            bits = line.split("|")
            pid = bits[0].strip()
            problem = bits[1].strip() if len(bits) > 1 else ""
            level = bits[2].strip() if len(bits) > 2 else args.level
            rows.append((pid, problem, level))
        return rows
    problem = args.problem or sys.stdin.read()
    if not problem.strip():
        sys.exit("no problem given: pass it as an argument, with -f, or on stdin")
    pid = args.id or re.sub(r"[^a-z0-9]+", "-", problem.strip()[:28].lower()).strip("-") or "page"
    return [(pid, problem, args.level)]


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate JumpAIS solution pages.")
    ap.add_argument("problem", nargs="?", help="the problem statement (Thai)")
    ap.add_argument("-f", "--file", help="batch file, one per line: id|โจทย์|ระดับชั้น")
    ap.add_argument("--id", help="page id for a single problem")
    ap.add_argument("--level", help="ระดับชั้น to pitch the explanation at, e.g. ม.4")
    ap.add_argument("--model", default="gemini-3.8-flash",
                    help="a Gemini model name, or an OpenRouter slug "
                         "(anything containing '/', e.g. openai/gpt-5.6-terra) "
                         "to route through OpenRouter instead")
    ap.add_argument("--effort", default="high", choices=list(EFFORT),
                    help="high is the shipped default; it buys explanation and animation, "
                         "and on 3.8 it also reduces label crowding")
    ap.add_argument("--label", help="run directory name (default: the id, or the batch filename)")
    ap.add_argument("--out", help="write the run here instead of spikes/boardtest/runs/<date>-<label>")
    ap.add_argument("--check", action="store_true",
                    help="run checks/check.mjs afterwards (needs Node; not in the demo bundle)")
    ap.add_argument("--jobs", type=int, default=4, help="parallel generations")
    ap.add_argument("--provider",
                    help="OpenRouter: pin a named upstream (e.g. Minimax, DeepInfra) "
                         "instead of routing by throughput. Ignored on the Google path.")
    ap.add_argument("--timeout", type=int, default=420,
                    help="seconds before a single generation is abandoned and retried")
    args = ap.parse_args()
    use_openrouter = is_openrouter_model(args.model)

    if use_openrouter:
        load_env()
        key = os.environ.get("OPENROUTER_API_KEY")
        if not key:
            sys.exit("OPENROUTER_API_KEY not set, and no .env beside this script or above it.\n"
                     "Copy .env.example to .env and paste your key into it.")
    else:
        if genai is None:
            sys.exit(
                "the Google GenAI SDK is not installed. Either:\n"
                "  uv run generate.py ...      (handles it for you, no install needed)\n"
                "  pip install google-genai    (then run with python3 as usual)"
            )
        load_env()
        key = os.environ.get("GOOGLE_CLOUD_API_KEY")
        if not key:
            sys.exit("GOOGLE_CLOUD_API_KEY not set, and no .env beside this script or above it.\n"
                     "Copy .env.example to .env and paste your key into it.")

    problems = read_problems(args)
    label = args.label or (Path(args.file).stem if args.file else problems[0][0])
    out = Path(args.out) if args.out else (
        runs_root() / f"{dt.date.today():%Y-%m-%d}-{label}"
    )
    for sub in ("prompts", "raw", "pages", "shots"):
        (out / sub).mkdir(parents=True, exist_ok=True)
    backend = "openrouter" if use_openrouter else "google-genai"
    (out / "MODEL").write_text(
        f"{args.model} (thinking_level={EFFORT[args.effort]}, backend={backend})\n",
        encoding="utf-8")
    if args.file:
        (out / "problems.txt").write_text(
            Path(args.file).read_text(encoding="utf-8"), encoding="utf-8")
    else:
        (out / "problems.txt").write_text(
            f"{problems[0][0]}|{problems[0][1]}|{problems[0][2] or ''}\n", encoding="utf-8")

    # Every page loads ./lib/ — point it at the one copy in the kit. Relative,
    # not absolute: these run directories are committed, and an absolute link
    # breaks the moment the repo is cloned or moved.
    link = out / "pages" / "lib"
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(os.path.relpath(HERE / "lib", link.parent))

    # A streamed call with no deadline can hang forever, and did: four problems
    # of sixty-eight sat with no output for thirteen minutes while the batch
    # waited on them. The agy path had --print-timeout and this one lost it.
    if use_openrouter:
        client = OpenRouterClient(api_key=key, timeout=args.timeout,
                                  provider=args.provider)
    else:
        client = genai.Client(vertexai=True, api_key=key,
                              http_options=types.HttpOptions(timeout=args.timeout * 1000))
    print(f"run   -> {out}")
    print(f"model -> {args.model}  thinking_level={EFFORT[args.effort]}  backend={backend}")

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futures = {
            pool.submit(run_problem, client, args.model, args.effort, out, pid, prob, lvl): pid
            for pid, prob, lvl in problems
        }
        for fut in concurrent.futures.as_completed(futures):
            pid = futures[fut]
            try:
                r = fut.result()
            except Exception as exc:                       # noqa: BLE001
                print(f"  FAILED    {pid:<22} {exc}")
                continue
            flags = []
            if r["retried"]:
                flags.append("retried once")
            if not r["complete"]:
                flags.append("STILL TRUNCATED")
            print(f"  generated {r['id']:<22} {r['bytes']:>6} bytes  "
                  f"{r['path']:<5} {' · '.join(flags)}")
            results.append(r)

    if not results:
        sys.exit("nothing generated")

    report = out / "report.txt"
    lines = ["path chosen (board = Shell.board, svg = Shell.canvas)"]
    lines += [f"  {r['id']:<22} {r['path']}" for r in sorted(results, key=lambda r: r["id"])]
    report.write_text("\n".join(lines) + "\n\n", encoding="utf-8")

    if args.check and STANDALONE:
        print("\n--check needs checks/check.mjs and Node; not in this bundle. "
              "Open the pages in a browser instead.")
    elif args.check:
        pages = sorted(str(r["page"]) for r in results)
        proc = subprocess.run(
            ["node", str(CHECKER), "--shots", str(out / "shots"), *pages],
            capture_output=True, text=True)
        with report.open("a", encoding="utf-8") as fh:
            fh.write(proc.stdout + proc.stderr)
        print(proc.stdout, end="")
        if proc.stderr:
            print(proc.stderr, file=sys.stderr, end="")
        if MOTION.exists():
            mot = subprocess.run(["node", str(MOTION), *pages],
                                 capture_output=True, text=True)
            with report.open("a", encoding="utf-8") as fh:
                fh.write(mot.stdout + mot.stderr)
            print(mot.stdout, end="")
            if mot.stderr:
                print(mot.stderr, file=sys.stderr, end="")

    print(f"\narchived: {out}")


if __name__ == "__main__":
    main()
