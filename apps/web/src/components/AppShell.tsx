/* The chrome every logged-in screen shares: a 64px white navbar with the
   product name on the left and the signed-in person plus a logout button on
   the right, a 1100px content column, and the copyright line pinned at the
   bottom. Every screen uses it unchanged now — there is no teacher/student
   split any more (see the section pivot), just a user, and an admin link
   that shows up for the one role that has somewhere else to go. */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import avatarUrl from "../icons/avatar.svg";
import signOutUrl from "../icons/sign-out.svg";
import logoUrl from "../icons/AniLearn.svg";
import { useSession } from "../lib/session";

export function AppShell({
  children,
  wide = false,
}: {
  children: ReactNode;
  /* the generation screen runs edge to edge instead of inside the 1100px column */
  wide?: boolean;
}) {
  const { user, signOut } = useSession();
  return (
    <div className="shell">
      <header className="navbar">
        <Link className="navbar-brand" to="/" title="AniLearn">
          <img src={logoUrl} alt="AniLearn logo" className="navbar-logo" width={32} height={32} />
          <span className="navbar-brand-name">AniLearn</span>
        </Link>
        <div className="navbar-right">
          {user?.role === "admin" ? (
            <Link className="ui-btn ui-btn-outline" to="/admin">
              จัดการคลังข้อสอบ
            </Link>
          ) : null}
          {user ? (
            <span className="navbar-user">
              {/* 25px circle, straight from the design */}
              <img className="navbar-avatar" src={avatarUrl} alt="" width={25} height={25} />
              <span className="navbar-name">{user.name}</span>
            </span>
          ) : null}
          <button className="ui-btn ui-btn-outline" onClick={() => void signOut()} type="button">
            {/* 20px glyph inside the button, as designed */}
            <img src={signOutUrl} alt="" width={20} height={20} />
            <span>ออกจากระบบ</span>
          </button>
        </div>
      </header>

      <main className={wide ? "shell-main shell-main-wide" : "shell-main"}>{children}</main>

      {!wide ? (
        <footer className="shell-footer">
          <p>Copyright © 2026 AniLearn</p>
        </footer>
      ) : null}
    </div>
  );
}
