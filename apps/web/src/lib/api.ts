/* The real backend.
 *
 * Everything the app knew before this file was a fixture: 68 pages that ship in
 * the repo and a localStorage store pretending to be a queue. This talks to the
 * API in apps/api, which owns classrooms, lessons, problems and pages, and to
 * the worker that actually runs the model.
 *
 * Two things are deliberate.
 *
 * Page HTML never comes through here. It is written to shared storage and
 * served by the pages origin, because a generated page runs model-written
 * JavaScript and has to sit in an opaque-origin sandbox. That is also why the
 * check report is fetched from the API rather than read out of the page: the
 * app cannot reach into that frame, by design.
 *
 * And every call can fail softly. The demo runs on a laptop against a
 * rate-limited model; a backend that is down should degrade to the fixtures
 * with a visible notice, not take the screen with it. `isLive()` is what the UI
 * asks before promising anything.
 */

const API = import.meta.env.VITE_API_URL || "/api";

export interface ApiPage {
  id: string;
  problem_id: string;
  status: "generating" | "ready" | "approved" | "rejected";
  kit_version: string | null;
  model: string | null;
  effort: string | null;
  path_chosen: "board" | "svg" | null;
  html_path: string | null;
  checks: unknown | null;
}

export interface ApiClassroom {
  id: string;
  name: string;
  subject: string | null;
  level: string | null;
  lesson_count: number;
}

export interface ApiLesson {
  id: string;
  title: string;
  chapter: string | null;
  status: string;
  problem_count: number;
  waiting_count?: number;
}

export interface ApiProblem {
  id: string;
  position: number;
  text: string | null;
  raw_text?: string | null;
  extracted_text?: string | null;
  source: string;
  image_path?: string | null;
  created_at?: string | null;
  page: ApiPage | null;
  job?: { id: string; state: string; stage: string | null } | null;
}

export interface JobEvent {
  state: "queued" | "running" | "done" | "failed";
  stage: string | null;
  progress: Record<string, unknown> | null;
  error: string | null;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail: unknown = await res.text();
    try {
      detail = JSON.parse(detail as string);
    } catch {
      /* a plain-text error is still an error */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

/** Same contract as req(), for a multipart body — used only by
 *  uploadProblemImage below. No Content-Type header: the browser has to set
 *  the multipart boundary itself, which it only does when fetch is left to
 *  pick the header on its own. */
async function reqForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`${API}${path}`, { method: "POST", body: form });
  if (!res.ok) {
    let detail: unknown = await res.text();
    try {
      detail = JSON.parse(detail as string);
    } catch {
      /* a plain-text error is still an error */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(public status: number, public detail: unknown) {
    super(`API ${status}`);
  }
}

/** Is the backend up? Cached briefly so every screen asking does not mean a
 *  request each. Returns false rather than throwing — callers use it to decide
 *  whether to promise real generation or fall back to fixtures. */
let liveCache: { at: number; ok: boolean } | null = null;
export async function isLive(maxAgeMs = 5000): Promise<boolean> {
  if (liveCache && Date.now() - liveCache.at < maxAgeMs) return liveCache.ok;
  let ok = false;
  try {
    const res = await fetch(`${API}/healthz`, { signal: AbortSignal.timeout(1500) });
    ok = res.ok;
  } catch {
    ok = false;
  }
  liveCache = { at: Date.now(), ok };
  return ok;
}

export const api = {
  classrooms: () => req<ApiClassroom[]>("/classrooms"),

  classroom: (classroomId: string) => req<ApiClassroom>(`/classrooms/${classroomId}`),

  createClassroom: (body: { name: string; subject?: string; level?: string }) =>
    req<{ id: string }>("/classrooms", { method: "POST", body: JSON.stringify(body) }),

  updateClassroom: (classroomId: string, body: { name?: string; subject?: string; level?: string }) =>
    req<ApiClassroom>(`/classrooms/${classroomId}`, { method: "PATCH", body: JSON.stringify(body) }),

  deleteClassroom: (classroomId: string) =>
    req<{ ok: boolean }>(`/classrooms/${classroomId}`, { method: "DELETE" }),

  /** `publishedOnly` is the confirmation gate as the API sees it. The student
   *  app asks with it set, and an unconfirmed lesson is not returned at all —
   *  not hidden in the UI, absent from the response. */
  lessons: (classroomId: string, publishedOnly = false) =>
    req<ApiLesson[]>(
      `/classrooms/${classroomId}/lessons${publishedOnly ? "?published_only=true" : ""}`
    ),

  createLesson: (classroomId: string, body: { title: string; chapter?: string }) =>
    req<{ id: string }>(`/classrooms/${classroomId}/lessons`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  deleteLesson: (lessonId: string) =>
    req<{ ok: boolean }>(`/lessons/${lessonId}`, { method: "DELETE" }),

  publishLesson: (lessonId: string) =>
    req<{ id: string; status: string }>(`/lessons/${lessonId}/publish`, { method: "POST" }),

  /** Undoes publishLesson — visibility only, see the endpoint's docstring: it
   *  does not touch any page's approval. */
  unpublishLesson: (lessonId: string) =>
    req<{ id: string; status: string }>(`/lessons/${lessonId}/unpublish`, { method: "POST" }),

  problems: (lessonId: string, approvedOnly = false) =>
    req<ApiProblem[]>(`/lessons/${lessonId}/problems${approvedOnly ? "?approved_only=true" : ""}`),

  /** Queue a generation. Returns immediately — the model takes 30-90 seconds,
   *  so the caller streams watchJob() rather than waiting on this. */
  addProblem: (lessonId: string, body: { text: string; level?: string }) =>
    req<{ problem_id: string; job_id: string }>(`/lessons/${lessonId}/problems`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  deleteProblem: (problemId: string) =>
    req<{ ok: boolean }>(`/problems/${problemId}`, { method: "DELETE" }),

  page: (pageId: string) => req<ApiPage>(`/pages/${pageId}`),

  /** The confirmation. seconds_on_page is sent because rubber-stamping is this
   *  design's silent failure and it has to be visible from the first day. */
  review: (pageId: string, body: { action: "approved" | "rejected"; note?: string; seconds_on_page?: number }) =>
    req<ApiPage>(`/pages/${pageId}/review`, { method: "POST", body: JSON.stringify(body) }),

  /** Ask a question about one page. Context is assembled server-side from the
   *  *approved* page only — never a fresh solve — which is what makes the
   *  returned `cites` (step numbers) meaningful: they point at steps a teacher
   *  actually looked at, not at something the chat made up. 409 means the page
   *  hasn't cleared review yet; callers should show that as "not available
   *  yet", not retry it as a transient failure. */
  askPage: (pageId: string, question: string) =>
    req<{ answer: string; cites: number[] }>(`/pages/${pageId}/ask`, {
      method: "POST",
      body: JSON.stringify({ question }),
    }),

  /** A photo instead of typed text. The model reads the image directly rather
   *  than this app OCRing it first — see Problem.extracted_text's docstring in
   *  apps/api/app/models.py for why the response still needs to be checked
   *  against what the model understood the problem to be before anyone trusts
   *  the page it produces. */
  uploadProblemImage: (lessonId: string, file: File, text?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (text && text.trim()) {
      form.append("text", text.trim());
    }
    return reqForm<{ problem_id: string; job_id: string; image_path?: string }>(`/lessons/${lessonId}/problems/image`, form);
  },
};

/** Stream one job's progress.
 *
 * Generation takes 30-90 seconds and a spinner for that long kills a live demo,
 * so the waiting screen shows the work: which stage, and what the checker
 * found. Returns a stop function.
 */
export function watchJob(
  jobId: string,
  onEvent: (e: JobEvent) => void,
  onDone: (e: JobEvent) => void
): () => void {
  const src = new EventSource(`${API}/jobs/${jobId}/events`);
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      src.close();
    }
  };
  src.onmessage = (m) => {
    let e: JobEvent;
    try {
      e = JSON.parse(m.data) as JobEvent;
    } catch {
      return;
    }
    onEvent(e);
    if (e.state === "done" || e.state === "failed") {
      onDone(e);
      close();
    }
  };
  /* An SSE error here is a dropped connection, not a failed job — report it,
     but do NOT close(). A generation reliably takes tens of seconds to
     minutes, plenty of time for one connection to drop, and calling close()
     here used to hand the browser's native EventSource reconnection nothing
     to do: the stream just stayed dead, onDone() never fired, and the caller
     (attachLiveJob, in lib/chat.ts) was left with no jobId-to-pageId result
     forever — a live generation that finished fine on the worker with no way
     for this tab to ever learn its pageId. The server has nothing to resume:
     GET /jobs/{id}/events just re-reads the job row fresh on every new
     connection, so leaving `src` open and letting the browser's own retry
     reconnect is enough to pick the stream back up once it can. */
  src.onerror = () => {
    onEvent({ state: "running", stage: "reconnecting", progress: null, error: null });
  };
  return close;
}

export const PAGES_URL = import.meta.env.VITE_PAGES_URL || "";

/** Worker output is served from /generated/, the fixtures from /pages/. Both
 *  live on the pages origin; only this function should know which is which. */
export type PageKind = "draft" | "generated" | "fixture";

/* Three paths on the pages origin, one per source:
 *
 *   /pages/      fixtures that ship in this repo
 *   /drafts/     the storage volume — a generated page awaiting review
 *   /generated/  the published volume — a page a teacher approved
 *
 * The draft path exists because hardening the gate removed it and took teacher
 * review with it: only approved pages were served, so the page a teacher is
 * supposed to look at before approving returned 404. A reviewer who cannot see
 * the page cannot review it, and the whole product rests on that step.
 *
 * Being explicit about what this is: with no authentication anywhere in this
 * system, /drafts/ is a product boundary, not a security one. The student app
 * never links it and the API never returns an unapproved page's path — but a
 * guessed URL would serve it. The separation that does hold is /generated/,
 * which physically contains only approved pages, so nothing can leak one by
 * accident. Real protection here needs auth on the pages origin. */
export function pageSrc(htmlPath: string, kind: PageKind = "generated") {
  if (kind === "fixture") return `${PAGES_URL}/pages/${htmlPath}`;
  if (kind === "draft") return `${PAGES_URL}/drafts/${htmlPath}`;
  return `${PAGES_URL}/generated/${htmlPath}`;
}
