# PoC plan

> **Superseded by [BUILD-PLAN.html](BUILD-PLAN.html)** (3 Sep 2026), which carries the
> same five stages plus what the generator work since 31 Aug changed: the review-screen
> signals, the vendored-kit sync, and the risks that turned out to matter. This file is
> kept for its schema and API notes.

Hackathon demo, production-ish shape. FastAPI + React, docker-compose on a laptop.
Full scope: generate → review → student view, plus student chat, plus photo upload.

## Build order

Each stage ends demoable. Nothing is half-built at any point, because the demo may be
given from any commit.

**1 — The student view, on fixtures.** 25 real generated pages are already in
`apps/pages/static/pages/`. Serve them from the page origin, embed one in a sandboxed
iframe, get the step-through and the responsive layout right. No API, no database.
*Demoable: a student stepping through a real solution.*

**2 — Teacher console and review, still on fixtures.** Submit box, queue list, review
screen with the page on one side and the check report on the other, approve/reject.
Fake the check report from the JSON the checker already emits.
*Demoable: the whole human loop.*

**3 — Database, jobs, worker, real generation.** Postgres, the schema below, one worker
loop, SSE progress. This is where the 30–90 second wait becomes real, so it is also where
the waiting screen earns its keep — see "The wait" below.
*Demoable: end to end, live.*

**4 — Student chat.** Scoped to the open page.

**5 — Photo upload and extraction.** Last on purpose: it is the stage most likely to
misbehave on stage, and putting it last means it cannot destabilise anything else.

## Data model

```
problem      id, source('text'|'image'), raw_text, image_path,
             extracted_text          -- editable; the only OCR mitigation
             extraction_confidence, level, created_by, created_at

page         id, problem_id, kit_version, model, effort,
             html_path, thumb_path, path_chosen('board'|'svg'),
             checks_json             -- window.__shellCheck, verbatim
             status('generating'|'ready'|'approved'|'rejected'),
             created_at

job          id, problem_id, kind('extract'|'generate'), state,
             stage, progress_json, attempts, error,
             started_at, finished_at

review       id, page_id, reviewer, action, note,
             seconds_on_page         -- see "Rubber-stamping" below
             created_at

chat_message id, page_id, student_id, role, content, created_at
```

`kit_version` is not decoration. It is what makes "improve the shell, re-execute every
past page" possible, and that has already paid off twice during development.

## API surface

```
POST   /problems                  {text} | multipart image  -> problem + job
GET    /problems                  the queue
PATCH  /problems/{id}             edit extracted_text, then re-generate
GET    /jobs/{id}/events          SSE: stage, progress, check results as they land
GET    /pages/{id}                metadata + checks
POST   /pages/{id}/approve        body: {note, seconds_on_page}
POST   /pages/{id}/reject         body: {reason}
POST   /pages/{id}/chat           SSE: streamed answer
```

Page HTML is never served by the API. It is written to the shared storage volume and
served by the `pages` origin.

## The pipeline

```
image? → extract → [teacher edits the text] → generate → check → thumbnail → ready
```

`extract` and `generate` are separate jobs with a human step between them. That gap is
the point: it is where a misread problem gets caught, and it is the only place it can be.

## The wait

Generation takes 30–90 seconds. A spinner for that long kills a live demo — but the checks
produce genuinely interesting output, so the waiting screen streams it: which drawing path
the model chose, label collisions per step, LaTeX leaks, explanation gaps, whether the
answer is present. Watching a page get audited is a better pitch than watching a spinner,
and it is honest about what the system does.

Pre-generate two problems before the demo anyway.

## Chat: the one real design risk

The page went through teacher review. The chat did not. So the chat must not be able to
contradict the approved page.

- Context is assembled from the approved page: the problem, each step's text and its `why`,
  and the answer with its sanity check. Not from a fresh solve.
- The system prompt makes the page authoritative and requires the model to say when the page
  does not cover something, rather than working it out itself.
- Answers cite step numbers, so a student can check the claim against what a teacher approved.

An unconstrained tutor bot beside a reviewed page quietly destroys the value of the review.

## Rubber-stamping

The review gate is the strongest correctness layer in the system, and it fails silently: if
approving twenty problems is slow, teachers click approve without reading and every metric
stays green. `review.seconds_on_page` is recorded from the first day so the failure is at
least visible. Design the review screen so the fast path is *reading*, not clicking — the
check report sorted worst-first, the flagged steps highlighted in the page itself.

## Carried risks

- **Extraction** — a misread photo yields a perfect page solving the wrong question, and
  every automated check passes it. Editable text is the whole mitigation.
- **Grade-appropriate method** — a page can be correct by a method the class has not been
  taught. Nothing verifies this; it is judgement, and it is the likely rejection reason.
- **Model arithmetic** — no CAS. The model still computes its own numbers.
- **Ill-posed input** — missing or contradictory values are undefined behaviour.
