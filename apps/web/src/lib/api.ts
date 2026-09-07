/* The real backend — sections, problems, pages, jobs, auth.
 *
 * Classrooms, lessons and enrollment are gone (see archive/b2b-classroom-poc
 * for the old model). Content is either global (every signed-in user, once
 * published) or personal (only its owner), organised by one self-referential
 * `Section` tree instead of a fixed classroom -> lesson shape — see
 * apps/api/app/models.py's own module docstring for the reasoning.
 *
 * Two things are deliberate, carried over from before this pivot.
 *
 * Page HTML never comes through here. It is written to shared storage and
 * served by the pages origin, because a generated page runs model-written
 * JavaScript and has to sit in an opaque-origin sandbox. That is also why the
 * check report is fetched from the API rather than read out of the page: the
 * app cannot reach into that frame, by design.
 *
 * Every request carries credentials. The session is an httpOnly cookie (see
 * lib/session.ts) — there is no token this code ever holds or attaches by
 * hand, `credentials: "include"` is the whole story. There is also no
 * fixture fallback any more: the old isLive()-and-degrade pattern existed
 * because a demo could still show something with the backend down; a real
 * account can't sign in with the backend down, so there is nothing honest to
 * fall back to.
 */

export const API = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

export class ApiError extends Error {
  constructor(public status: number, public detail: unknown) {
    super(`API ${status}`);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    credentials: "include",
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
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Same contract as req(), for a multipart body — the browser has to set the
 *  boundary itself, which it only does when fetch picks the header on its own. */
async function reqForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`${API}${path}`, { method: "POST", credentials: "include", body: form });
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

// ------------------------------------------------------------------ shapes --

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
  created_at?: string | null;
}

export type Scope = "global" | "personal";

export interface ApiSection {
  id: string;
  parent_id: string | null;
  scope: Scope;
  owner_id: string | null;
  title: string;
  kind: string | null;
  position: number;
  depth: number;
  status: "draft" | "published";
  published_at: string | null;
}

export interface ApiProblem {
  id: string;
  section_id: string | null;
  scope: Scope;
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

export const api = {
  // ---- sections ----------------------------------------------------------

  /** Every global section this account can see — a flat list, not a nested
   *  tree; the frontend builds the tree from parent_id. An admin sees drafts
   *  too, since they're the one editing the library. */
  globalSections: () => req<ApiSection[]>("/sections/global"),

  mySections: () => req<ApiSection[]>("/sections/mine"),

  createSection: (body: { parent_id?: string | null; scope: Scope; title: string; kind?: string }) =>
    req<ApiSection>("/sections", { method: "POST", body: JSON.stringify(body) }),

  updateSection: (
    sectionId: string,
    body: { title?: string; kind?: string | null; position?: number; parent_id?: string | null }
  ) => req<ApiSection>(`/sections/${sectionId}`, { method: "PATCH", body: JSON.stringify(body) }),

  publishSection: (sectionId: string) =>
    req<ApiSection>(`/sections/${sectionId}/publish`, { method: "POST" }),

  unpublishSection: (sectionId: string) =>
    req<ApiSection>(`/sections/${sectionId}/unpublish`, { method: "POST" }),

  deleteSection: (sectionId: string) =>
    req<{ ok: boolean }>(`/sections/${sectionId}`, { method: "DELETE" }),

  // ---- problems -----------------------------------------------------------

  /** Personal generation — the core loop. No section required; an unfiled
   *  problem lands in the caller's own inbox (see myProblems). */
  addProblem: (body: { text: string; level?: string; section_id?: string }) =>
    req<{ problem_id: string; job_id: string }>("/problems", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  addProblemImage: (file: File, opts?: { text?: string; level?: string; sectionId?: string }) => {
    const form = new FormData();
    form.append("file", file);
    if (opts?.text?.trim()) form.append("text", opts.text.trim());
    if (opts?.level?.trim()) form.append("level", opts.level.trim());
    if (opts?.sectionId) form.append("section_id", opts.sectionId);
    return reqForm<{ problem_id: string; job_id: string; image_path?: string }>("/problems/image", form);
  },

  /** Admin-only: files a problem straight into a global section. */
  addGlobalProblem: (sectionId: string, body: { text: string; level?: string }) =>
    req<{ problem_id: string; job_id: string }>(`/sections/${sectionId}/problems`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** Admin-only bulk import — a past-papers book is forty questions; adding
   *  them one at a time is the reason a global library stays empty. */
  addGlobalProblemsBulk: (sectionId: string, items: { text: string; level?: string }[]) =>
    req<{ problem_id: string; job_id: string }[]>(`/sections/${sectionId}/problems/bulk`, {
      method: "POST",
      body: JSON.stringify({ items }),
    }),

  addGlobalProblemImage: (sectionId: string, file: File, opts?: { text?: string; level?: string }) => {
    const form = new FormData();
    form.append("file", file);
    if (opts?.text?.trim()) form.append("text", opts.text.trim());
    if (opts?.level?.trim()) form.append("level", opts.level.trim());
    return reqForm<{ problem_id: string; job_id: string; image_path?: string }>(
      `/sections/${sectionId}/problems/image`,
      form
    );
  },

  sectionProblems: (sectionId: string) => req<ApiProblem[]>(`/sections/${sectionId}/problems`),

  /** The personal library's inbox: every problem this account has ever
   *  generated, filed or not, newest first. */
  myProblems: () => req<ApiProblem[]>("/problems/mine"),

  deleteProblem: (problemId: string) => req<{ ok: boolean }>(`/problems/${problemId}`, { method: "DELETE" }),

  // ---- pages ----------------------------------------------------------------

  page: (pageId: string) => req<ApiPage>(`/pages/${pageId}`),

  /** The confirmation — global content only. seconds_on_page is sent because
   *  rubber-stamping is this design's silent failure and has to be visible
   *  from the first day. */
  review: (pageId: string, body: { action: "approved" | "rejected"; note?: string; seconds_on_page?: number }) =>
    req<ApiPage>(`/pages/${pageId}/review`, { method: "POST", body: JSON.stringify(body) }),

  /** Ask a question about a page. Global content needs `approved`; personal
   *  content — which has no review gate at all — only needs `ready`, and
   *  only for its own owner. 409 means the page isn't visible to ask about
   *  yet; show that as "not available", not a transient failure. */
  askPage: (pageId: string, question: string) =>
    req<{ answer: string; cites: number[] }>(`/pages/${pageId}/ask`, {
      method: "POST",
      body: JSON.stringify({ question }),
    }),
};

/** Stream one job's progress.
 *
 * Generation takes 30-90 seconds and a spinner for that long kills a live demo,
 * so the waiting screen shows the work: which stage, and what the checker
 * found. Returns a stop function.
 */
export function watchJob(jobId: string, onEvent: (e: JobEvent) => void, onDone: (e: JobEvent) => void): () => void {
  const src = new EventSource(`${API}/jobs/${jobId}/events`, { withCredentials: true });
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
     but do NOT close(). Generation reliably takes tens of seconds to minutes,
     plenty of time for one connection to drop, and the browser's own
     EventSource retry will reconnect: GET /jobs/{id}/events just re-reads the
     job row fresh on every new connection, so there is nothing to resume. */
  src.onerror = () => {
    onEvent({ state: "running", stage: "reconnecting", progress: null, error: null });
  };
  return close;
}

export const PAGES_URL = import.meta.env.VITE_PAGES_URL ?? "http://localhost:8080";

/** A generated page is served from one of two paths depending on approval —
 *  see apps/api/app/main.py's _publish_page_file and CLAUDE.md's "a page a
 *  teacher has not approved is not in the students' path at all". */
export type PageKind = "draft" | "generated";

/* draft      -> the storage volume, /drafts/  — anything not yet approved,
                 including every personal page (which never goes through
                 review at all — see models.py's Review docstring).
   generated  -> the published volume, /generated/ — approved global content
                 only; this path physically cannot contain anything else.

   With no authentication on the pages origin itself, /drafts/ is a product
   boundary, not a security one: a page id is a uuid4 filename, not linked
   anywhere a stranger would find it, but a guessed URL would still serve it.
   Real protection needs auth on the pages origin — not built yet. */
export function pageSrc(htmlPath: string, kind: PageKind) {
  return kind === "generated" ? `${PAGES_URL}/generated/${htmlPath}` : `${PAGES_URL}/drafts/${htmlPath}`;
}

/** Which path a page is actually reachable at, given what the API says about
 *  it — the one place this decision gets made, so a screen doesn't have to
 *  re-derive "approved global" vs "everything else" itself. */
export function pageKindOf(page: ApiPage): PageKind {
  return page.status === "approved" ? "generated" : "draft";
}
