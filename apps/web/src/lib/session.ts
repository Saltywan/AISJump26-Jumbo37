/* A real session, backed by the API's httpOnly cookie (see apps/api/app/auth.py).
 *
 * This file used to be an explicit, admitted fake — a role picker with no
 * password check, kept honest by never pretending otherwise. It said "when
 * auth does arrive only this file changes." This is that change: every call
 * goes to /auth/*, the cookie itself is invisible to this code on purpose
 * (httpOnly — that's what makes it worth having), and `role` is now
 * `user | admin` rather than `teacher | student`, because nothing here is a
 * classroom any more (see the section pivot).
 *
 * There is no localStorage fallback and no offline mode. A personal library
 * that must follow its owner across devices needs a server-trusted identity,
 * so unlike the old isLive()-and-degrade-to-fixtures pattern, a session with
 * no reachable API is just signed out — there is nothing honest to fall back to.
 */
import { useSyncExternalStore } from "react";
import { API, ApiError } from "./api";

export type Role = "user" | "admin";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

let current: User | null = null;
let resolved = false; // has the initial GET /auth/me finished, one way or the other
const listeners = new Set<() => void>();

function set(user: User | null) {
  current = user;
  resolved = true;
  listeners.forEach((f) => f());
}

async function fetchMe(): Promise<User | null> {
  try {
    const res = await fetch(`${API}/auth/me`, { credentials: "include" });
    if (!res.ok) return null;
    return (await res.json()) as User;
  } catch {
    return null;
  }
}

// Runs once, at module load — every screen's first render can ask
// useSession() before this settles, which is what `resolved` is for: "no
// user yet" during that window must not read the same as "checked, and
// you're signed out" or every route guard fires and bounces straight to
// /login before the cookie's even been asked about.
void fetchMe().then(set);

async function authRequest(path: string, body: unknown): Promise<User> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
  return (await res.json()) as User;
}

export function useSession() {
  const user = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => null
  );
  const isResolved = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => resolved,
    () => false
  );
  return {
    user,
    /** False only during the one-time startup check; a route guard should
     *  wait for this before deciding there is no session. */
    resolved: isResolved,
    async login(email: string, password: string) {
      const u = await authRequest("/auth/login", { email, password });
      set(u);
      return u;
    },
    async register(email: string, password: string, name: string) {
      const u = await authRequest("/auth/register", { email, password, name });
      set(u);
      return u;
    },
    async signOut() {
      try {
        await fetch(`${API}/auth/logout`, { method: "POST", credentials: "include" });
      } finally {
        set(null);
      }
    },
  };
}
