/* A pretend session.
 *
 * The design has a Login screen, so the app has one. It does not have auth:
 * the target for this build is a laptop demo, and a real identity provider is
 * out of scope. This module is the seam — every screen asks it who is signed in
 * and gets an answer, so when auth does arrive only this file changes.
 *
 * Nothing here is a security boundary and it must never be mistaken for one.
 * Anyone can pick either role from the login screen, and the "password" is
 * ignored entirely. */
import { useSyncExternalStore } from "react";

export type Role = "teacher" | "student";

export interface User {
  name: string;
  role: Role;
}

const KEY = "jumpais.session.v1";

/* The two demo identities are the ones written into the Figma screens, so the
   built app reads like the design rather than like Lorem Ipsum. */
export const DEMO_USERS: Record<Role, User> = {
  teacher: { name: "คุณครูสมชาย ใจดี", role: "teacher" },
  student: { name: "ด.ญ. สมหญิง สุดแสนสวย", role: "student" },
};

let current: User | null = read();
const listeners = new Set<() => void>();

function read(): User | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

function write(u: User | null) {
  current = u;
  try {
    if (u) localStorage.setItem(KEY, JSON.stringify(u));
    else localStorage.removeItem(KEY);
  } catch {
    /* a private window still gets a working session for this tab */
  }
  listeners.forEach((f) => f());
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
  return {
    user,
    signIn: (role: Role) => write(DEMO_USERS[role]),
    signOut: () => write(null),
  };
}
