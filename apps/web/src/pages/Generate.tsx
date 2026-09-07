/* The core loop: type or photograph a problem, watch it generate, get the
 * artifact. Always personal — global content is admin-managed from /admin,
 * never from here (see the section pivot's "no non-admin writes to global"
 * decision) — and filing into a section is optional: an unfiled problem
 * lands in the library's own inbox, because the core loop should not make a
 * user decide where to file something before they can generate it at all.
 *
 * This replaces the old TeacherChat.tsx, which was built around a classroom
 * and a lesson and a sidebar of past threads under them. None of that exists
 * any more — "past threads" is just the library now (GET /problems/mine),
 * server-owned, so this screen only ever has to hold ONE generation, not a
 * whole history of them.
 */
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { ProblemArtifact } from "../components/ProblemArtifact";
import { useSession } from "../lib/session";
import { api, watchJob, type ApiProblem, type JobEvent } from "../lib/api";
import imageUrl from "../icons/image.svg";
import sendUrl from "../icons/send.svg";

const STAGE_LABEL: Record<string, string> = {
  queued: "เข้าคิวแล้ว",
  generating: "กำลังให้ AI เขียนหน้า",
  checking: "กำลังตรวจหน้าที่สร้าง",
  reconnecting: "กำลังเชื่อมต่อใหม่",
};

export default function Generate() {
  const { user } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const sectionId = params.get("section") || undefined;

  const [text, setText] = useState("");
  const [stage, setStage] = useState<JobEvent | null>(null);
  const [problemId, setProblemId] = useState<string | null>(null);
  const [result, setResult] = useState<ApiProblem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stopWatch = useRef<(() => void) | null>(null);

  useEffect(() => () => stopWatch.current?.(), []);

  function begin(jobId: string, pid: string) {
    setProblemId(pid);
    setStage({ state: "queued", stage: "queued", progress: null, error: null });
    stopWatch.current?.();
    stopWatch.current = watchJob(
      jobId,
      (e) => setStage(e),
      async (e) => {
        if (e.state === "failed") {
          setError(e.error || "สร้างไม่สำเร็จ");
          setProblemId(null);
          return;
        }
        // The job is done; the resulting Page is easiest to read back through
        // the exact same shape every other screen already renders (see
        // components/ProblemArtifact.tsx) rather than reconstructing an
        // ApiProblem by hand from the job's own progress payload.
        const mine = await api.myProblems();
        const found = mine.find((p) => p.id === pid);
        if (found) setResult(found);
        setProblemId(null);
      }
    );
  }

  async function submitText() {
    const t = text.trim();
    if (!t) return;
    setError(null);
    setText("");
    try {
      const { problem_id, job_id } = await api.addProblem({ text: t, section_id: sectionId });
      begin(job_id, problem_id);
    } catch {
      setError("ส่งโจทย์ไม่สำเร็จ ลองใหม่อีกครั้ง");
    }
  }

  async function submitImage(file: File) {
    setError(null);
    try {
      const { problem_id, job_id } = await api.addProblemImage(file, { sectionId });
      begin(job_id, problem_id);
    } catch {
      setError("อัปโหลดรูปไม่สำเร็จ ลองใหม่อีกครั้ง");
    }
  }

  function onFileChosen(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void submitImage(file);
  }

  if (!user) return null;
  const busy = !!problemId;

  return (
    <AppShell wide>
      <div className="chat-shell chat-shell-noside">
        <div className="chat-main">
          <div className="chat-scroll">
            {!result && !busy ? (
              <div className="chat-empty">
                <h2>วันนี้อยากสร้างสื่อการสอนเกี่ยวกับอะไร?</h2>
                <p>พิมพ์โจทย์คณิตศาสตร์หรือฟิสิกส์ หรือแนบรูปโจทย์ แล้ว AI จะช่วยสร้าง Animation ให้</p>
              </div>
            ) : (
              <div className="chat-thread">
                {error ? <p className="form-field-error">{error}</p> : null}
                {busy ? (
                  <div className="gen-card">
                    <div className="gen-card-generating">
                      <span className="spinner" /> กำลังสร้างสื่อการสอน…
                      {stage?.stage ? (
                        <span className="gen-card-stage-label">{STAGE_LABEL[stage.stage] ?? stage.stage}</span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {result ? (
                  <>
                    <ProblemArtifact problem={result} isAdmin={false} isMine onChanged={() => setResult(null)} />
                    <button
                      type="button"
                      className="ui-btn ui-btn-outline"
                      onClick={() => {
                        setResult(null);
                        navigate("/");
                      }}
                    >
                      กลับไปที่ห้องสมุด
                    </button>
                  </>
                ) : null}
              </div>
            )}
          </div>

          <div className="chat-input-bar">
            <input ref={fileInputRef} type="file" accept="image/*" className="chat-input-file" onChange={onFileChosen} />
            <button
              type="button"
              className="chat-input-attach"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              aria-label="แนบรูปโจทย์"
              title="แนบรูปโจทย์"
            >
              <img src={imageUrl} alt="" width={20} height={20} />
            </button>
            <input
              className="chat-input-field"
              value={text}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submitText();
                }
              }}
              placeholder="พิมพ์โจทย์ที่นี่ หรือแนบรูปโจทย์"
            />
            <button type="button" className="chat-input-send" onClick={() => void submitText()} disabled={busy || !text.trim()} aria-label="ส่ง">
              <img src={sendUrl} alt="" width={20} height={20} />
            </button>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
