/* The chrome every logged-in screen in the design shares: a 64px white navbar
   with the product name on the left and the signed-in person plus a logout
   button on the right, a 1100px content column, and the copyright line pinned
   at the bottom. Both the teacher and the student screens use it unchanged —
   only the name and the links inside differ. */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import avatarUrl from "../icons/avatar.svg";
import signOutUrl from "../icons/sign-out.svg";
import { useSession } from "../lib/session";

export function AppShell({
  children,
  wide = false,
}: {
  children: ReactNode;
  /* the chat screens run edge to edge instead of inside the 1100px column */
  wide?: boolean;
}) {
  const { user, signOut } = useSession();
  return (
    <div className="shell">
      <header className="navbar">
        <Link className="navbar-brand" to={user?.role === "teacher" ? "/t" : "/s"}>
          JumpAIS
        </Link>
        <div className="navbar-right">
          {user ? (
            <span className="navbar-user">
              {/* 25px circle, straight from the design */}
              <img className="navbar-avatar" src={avatarUrl} alt="" width={25} height={25} />
              <span className="navbar-name">{user.name}</span>
            </span>
          ) : null}
          <button className="ui-btn ui-btn-outline" onClick={signOut} type="button">
            {/* 20px glyph inside the button, as designed */}
            <img src={signOutUrl} alt="" width={20} height={20} />
            <span>ออกจากระบบ</span>
          </button>
        </div>
      </header>

      <main className={wide ? "shell-main shell-main-wide" : "shell-main"}>{children}</main>

      {!wide ? (
        <footer className="shell-footer">
          <p>Copyright © 2026 JumpAIS</p>
        </footer>
      ) : null}
    </div>
  );
}
