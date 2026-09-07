/* Login, from Figma node 60:7141 — reproduced as designed, minus the "Sign In
 * with Google" button and the role picker underneath it.
 *
 * Both existed only because there was no real auth (see lib/session.ts's old
 * header comment): the role picker because something had to decide teacher
 * vs. student with no backend to ask, Google because the design had a button
 * there and nothing behind it either. There is no teacher/student split any
 * more (see the section pivot), and there is now a real account behind this
 * form — email and password actually mean something, so a fake OAuth button
 * next to a real login is a worse kind of dishonest than the old demo control
 * ever was. If social login is ever built, it goes back in here; until then
 * the field is just the field.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Input } from "../components/ui";
import { useSession } from "../lib/session";
import { ApiError } from "../lib/api";

export default function Login() {
  const { user, login } = useSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /* Navigate once the session has actually propagated, not in the same tick
     as login(). Calling navigate() straight after it looked right and did
     not work once, on the old fake session — the route guard re-rendered
     before the store update reached it, saw no user, and redirected back to
     /login with replace — so the session was set and the screen never
     moved. */
  useEffect(() => {
    if (user) navigate("/", { replace: true });
  }, [user, navigate]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await login(email.trim().toLowerCase(), password);
    } catch (err) {
      setError(err instanceof ApiError ? "อีเมลหรือรหัสผ่านไม่ถูกต้อง" : "เข้าสู่ระบบไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-ground">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-title">เข้าสู่ระบบ</h1>

        <div className="login-fields">
          <Input
            label="อีเมล"
            type="email"
            placeholder="you@example.com"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Input
            label="รหัสผ่าน"
            type="password"
            placeholder="รหัสผ่าน"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error ? (
            <p className="form-field-error" role="alert">
              {error}
            </p>
          ) : null}
          <Button variant="primary" type="submit" className="ui-btn-block" disabled={submitting}>
            {submitting ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}
          </Button>
        </div>

        <p className="login-switch">
          ยังไม่มีบัญชี? <Link to="/register">สมัครสมาชิก</Link>
        </p>
      </form>
    </div>
  );
}
