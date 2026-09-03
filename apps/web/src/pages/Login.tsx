/* Login, from Figma node 60:7141.
 *
 * The design is a 450px card on the BG ground: a Heading 4 title, two labelled
 * inputs, a full-width primary button, an "or" rule, and a dashed Google
 * button. It is reproduced as designed — but there is no auth behind it (see
 * lib/session.ts). The fields accept anything, and the role picker below them
 * is an addition the design does not have, because without a backend something
 * has to decide whether you land in the teacher app or the student one. It is
 * labelled as a demo control rather than dressed up as part of the product. */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Input } from "../components/ui";
import { useSession, type Role } from "../lib/session";
import googleUrl from "../icons/google.svg";

export default function Login() {
  const { user, signIn } = useSession();
  const navigate = useNavigate();
  const [role, setRole] = useState<Role>("teacher");

  /* Navigate once the session has actually propagated, not in the same tick as
     signIn(). Calling navigate() straight after it looked right and did not
     work: the route guard re-rendered before the store update reached it, saw
     no user, and redirected back to /login with replace — so the session was
     set and the screen never moved. */
  useEffect(() => {
    if (user) navigate(user.role === "teacher" ? "/t" : "/s", { replace: true });
  }, [user, navigate]);

  function enter() {
    signIn(role);
  }

  return (
    <div className="login-ground">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          enter();
        }}
      >
        <h1 className="login-title">Login</h1>

        <div className="login-fields">
          <Input label="Username or Email" placeholder="Enter username or email" autoComplete="username" />
          <Input label="Password" type="password" placeholder="Enter password" autoComplete="current-password" />
          <Button variant="primary" type="submit" className="ui-btn-block">
            Login
          </Button>
        </div>

        <div className="login-alt">
          <div className="login-or">
            <span className="login-rule" />
            <span className="login-or-text">or</span>
            <span className="login-rule" />
          </div>
          <button className="login-google" type="button" onClick={enter}>
            <img src={googleUrl} alt="" width={15} height={15} />
            <span>Sign In with Google</span>
          </button>
        </div>

        {/* Not in the design. There is no auth, so the role has to come from
            somewhere, and a visible switch is more honest than guessing. */}
        <div className="login-demo">
          <span className="login-demo-label">เข้าสู่ระบบในฐานะ (เดโม)</span>
          <div className="login-roles">
            <button
              type="button"
              className={`login-role ${role === "teacher" ? "login-role-on" : ""}`}
              onClick={() => setRole("teacher")}
            >
              ครู
            </button>
            <button
              type="button"
              className={`login-role ${role === "student" ? "login-role-on" : ""}`}
              onClick={() => setRole("student")}
            >
              นักเรียน
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
