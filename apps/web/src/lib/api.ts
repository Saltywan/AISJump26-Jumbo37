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

const API = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

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

export interface ApiProblem {
  id: string;
  position: number;
  text: string | null;
  source: string;
  page: ApiPage | null;
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
  classrooms: () => req<{ id: string; name: string; subject: string | null; level: string | null; lesson_count: number }[]>("/classrooms"),

  createClassroom: (body: { name: string; subject?: string; level?: string }) =>
    req<{ id: string }>("/classrooms", { method: "POST", body: JSON.stringify(body) }),

  /** `publishedOnly` is the confirmation gate as the API sees it. The student
   *  app asks with it set, and an unconfirmed lesson is not returned at all —
   *  not hidden in the UI, absent from the response. */
  lessons: (classroomId: string, publishedOnly = false) =>
    req<{ id: string; title: string; chapter: string | null; status: string; problem_count: number }[]>(
      `/classrooms/${classroomId}/lessons${publishedOnly ? "?published_only=true" : ""}`
    ),

  createLesson: (classroomId: string, body: { title: string; chapter?: string }) =>
    req<{ id: string }>(`/classrooms/${classroomId}/lessons`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  publishLesson: (lessonId: string) =>
    req<{ id: string; status: string }>(`/lessons/${lessonId}/publish`, { method: "POST" }),

  problems: (lessonId: string, approvedOnly = false) =>
    req<ApiProblem[]>(`/lessons/${lessonId}/problems${approvedOnly ? "?approved_only=true" : ""}`),

  /** Queue a generation. Returns immediately — the model takes 30-90 seconds,
   *  so the caller streams watchJob() rather than waiting on this. */
  addProblem: (lessonId: string, body: { text: string; level?: string }) =>
    req<{ problem_id: string; job_id: string }>(`/lessons/${lessonId}/problems`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  page: (pageId: string) => req<ApiPage>(`/pages/${pageId}`),

  /** The confirmation. seconds_on_page is sent because rubber-stamping is this
   *  design's silent failure and it has to be visible from the first day. */
  review: (pageId: string, body: { action: "approved" | "rejected"; note?: string; seconds_on_page?: number }) =>
    req<ApiPage>(`/pages/${pageId}/review`, { method: "POST", body: JSON.stringify(body) }),
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
  /* An SSE error here is a dropped connection, not a failed job. Report it and
     stop; the caller can fall back to polling GET /jobs/{id} rather than being
     left with a spinner that never resolves. */
  src.onerror = () => {
    onEvent({ state: "running", stage: "reconnecting", progress: null, error: null });
    close();
  };
  return close;
}

export const PAGES_URL = import.meta.env.VITE_PAGES_URL ?? "http://localhost:8080";

/** Worker output is served from /generated/, the fixtures from /pages/. Both
 *  live on the pages origin; only this function should know which is which. */
export function pageSrc(htmlPath: string, kind: "generated" | "fixture" = "generated") {
  return kind === "generated"
    ? `${PAGES_URL}/generated/${htmlPath}`
    : `${PAGES_URL}/pages/${htmlPath}`;
}
