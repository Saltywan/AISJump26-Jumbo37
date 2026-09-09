/* Registration — the same 450px card as Login, no Figma frame for it since
 * the design predates real accounts entirely. Built from Login's own parts
 * rather than a new visual language. */
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, ButtonLink, Input } from "../components/ui";
import { useSession } from "../lib/session";
import { ApiError } from "../lib/api";
import logoUrl from "../icons/AniLearn.svg";

export default function Register() {
  const allowRegistration = import.meta.env.VITE_ALLOW_REGISTRATION !== "false";
  const { user, register } = useSession();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user) navigate("/", { replace: true });
  }, [user, navigate]);

  if (!allowRegistration) {
    return (
      <div className="login-ground">
        <div className="login-card">
          <div className="login-brand">
            <img src={logoUrl} alt="AniLearn logo" className="login-brand-logo" width={48} height={48} />
            <span className="login-brand-name">AniLearn</span>
          </div>
          <h1 className="login-title">ระบบปิดรับสมัครชั่วคราว</h1>
          <p style={{ textAlign: "center", color: "var(--ink-muted)", margin: "8px 0 20px", fontSize: "var(--text-body)" }}>
            ขณะนี้ระบบยังไม่เปิดรับการลงทะเบียนผู้ใช้ใหม่ กรุณาเข้าสู่ระบบด้วยบัญชีที่มีอยู่แล้ว
          </p>
          <ButtonLink variant="primary" to="/login" className="ui-btn-block">
            กลับไปหน้าเข้าสู่ระบบ
          </ButtonLink>
        </div>
      </div>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (password.length < 8) {
      setError("รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await register(email.trim().toLowerCase(), password, name.trim());
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? "มีบัญชีที่ใช้อีเมลนี้อยู่แล้ว"
          : "สมัครสมาชิกไม่สำเร็จ ลองใหม่อีกครั้ง"
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-ground">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <img src={logoUrl} alt="AniLearn logo" className="login-brand-logo" width={48} height={48} />
          <span className="login-brand-name">AniLearn</span>
        </div>
        <h1 className="login-title">สมัครสมาชิก</h1>

        <div className="login-fields">
          <Input label="ชื่อ" placeholder="ชื่อของคุณ" value={name} onChange={(e) => setName(e.target.value)} required />
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
            placeholder="อย่างน้อย 8 ตัวอักษร"
            autoComplete="new-password"
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
            {submitting ? "กำลังสมัคร…" : "สมัครสมาชิก"}
          </Button>
        </div>

        <p className="login-switch">
          มีบัญชีอยู่แล้ว? <Link to="/login">เข้าสู่ระบบ</Link>
        </p>
      </form>
    </div>
  );
}
