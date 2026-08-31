# JumpAIS — app

A teacher submits a Thai maths or physics problem. The system generates a step-by-step
animated solution page, checks it mechanically, and puts it in a review queue. **A teacher
approves it before any student sees it.** Students then step through the page and ask
questions about it.

The generation layer is not built here — it is vendored, pinned, in `packages/kit/`. This
repo is the service around it. The research repo that produced the kit is `../JumpAIS`.

## Run it

```bash
cp .env.example .env        # add GOOGLE_CLOUD_API_KEY
docker compose up --build
```

| | | |
|---|---|---|
| web | http://localhost:5173 | teacher console + student view |
| api | http://localhost:8000 | REST + SSE |
| pages | http://localhost:8080 | generated pages, **separate origin on purpose** |
| db | localhost:5432 | postgres |

## Layout

```
apps/api        FastAPI — REST, SSE job progress, chat streaming
apps/worker     the pipeline: extract → generate → check → thumbnail
apps/web        Vite + React + TS
apps/pages      nginx config for the page origin (static only)
packages/kit    the vendored generation kit — lib/, prompts/, checks/, VERSION
docs/PLAN.md    build order, data model, API surface, carried risks
```

## Three things that are not negotiable

**Generated pages contain model-written scripts.** They render in an iframe with
`sandbox="allow-scripts"` and *without* `allow-same-origin`, served from a different origin
than the app. The opaque origin is the real boundary; the CSP on the page server is defence
in depth, and `connect-src 'none'` there is the part that stops a page phoning home. A page
must never be rendered inline in the app.

**Every page records the kit version it was generated against.** See `packages/kit/VERSION`.
This is what lets a shell improvement upgrade every past page by re-executing it, at no model
cost. It only works if nothing loads from a CDN, so nothing does.

**Extraction is the failure nothing downstream can see.** A misread photo produces a
flawless page solving the wrong problem, and every check passes. The extracted text is shown
in an editable field before generation starts. That field is the entire mitigation — it is
not an optional convenience.

## Never

Do not call `sympify()` on model output — it evaluates its input as Python, which is remote
code execution on the worker. If a CAS is added, use `parse_expr` with an explicit restricted
namespace, an allowlist, and a time cap.
