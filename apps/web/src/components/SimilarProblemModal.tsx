/* "Make one like this" — options-first, unlike the AskPanel's two text-first
 * modes (ถามคำถาม / ขอให้แก้ไขหน้านี้ in ProblemArtifact.tsx). The outcome is
 * also a different kind of thing: those two act on the page you're looking
 * at; this creates a new entry somewhere else in your library. A modal with
 * its own options row is the right shape for that, the same reasoning
 * SectionModals.tsx's form already follows for "this needs its own fields,
 * not a single text box".
 *
 * Never a write to the source problem — see lib/api.ts's generateSimilar()
 * and apps/api/app/main.py's generate_similar() for why that's what lets a
 * global (คลังข้อสอบ) page be a source here at all, unlike revision.
 */
import { useState, type FormEvent } from "react";
import { Button, EffortSelect, Textarea, VariationSelect } from "./ui";
import { ModalDialog } from "./Modal";
import { api, ApiError, type ApiProblem, type Effort, type Variation } from "../lib/api";
import "./creation-modals.css";

// Same floor as fresh generation and revision — a variant is a real
// generation-class model call (see main.py's _validate_effort).
const SIMILAR_EFFORT_OPTIONS = ["medium", "high"] as const;

export function SimilarProblemModal({
  problem,
  onClose,
  onCreated,
}: {
  problem: ApiProblem;
  onClose: () => void;
  onCreated: (result: { problemId: string; jobId: string }) => void;
}) {
  const [variation, setVariation] = useState<Variation>("same");
  const [steer, setSteer] = useState("");
  // Inherit the source page's own effort, same rule revise uses — a variant
  // of a high-effort page shouldn't silently get cheaper by defaulting to
  // medium. Generation refuses "low", so fall back to "high" when the
  // source has none recorded (an old page, or one made before effort was
  // choosable at all).
  const sourceEffort = problem.page?.effort;
  const [effort, setEffort] = useState<Effort>(sourceEffort === "medium" ? "medium" : "high");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const { problem_id, job_id } = await api.generateSimilar(problem.id, {
        variation,
        steer: steer.trim() || undefined,
        effort,
      });
      onCreated({ problemId: problem_id, jobId: job_id });
    } catch (err) {
      // ApiError.detail is the WHOLE parsed response body (see lib/api.ts's
      // req()), and FastAPI wraps a dict HTTPException detail one level
      // further — raise HTTPException(409, {"error": "..."}) serialises as
      // {"detail": {"error": "..."}} — so the actual message sits at
      // detail.detail.error, not detail.error. Fall back to a generic
      // message rather than risk showing "undefined" if that shape ever
      // changes.
      const status = err instanceof ApiError ? err.status : undefined;
      const serverMessage =
        err instanceof ApiError && err.detail && typeof err.detail === "object" && "detail" in err.detail
          ? (err.detail as { detail?: { error?: string } }).detail?.error
          : undefined;
      setError(serverMessage || (status === 409 ? "สร้างตอนนี้ไม่ได้ ลองใหม่ภายหลัง" : "สร้างโจทย์คล้ายกันไม่สำเร็จ ลองใหม่อีกครั้ง"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalDialog onClose={onClose} labelledBy="similar-problem-title" className="form-modal-card">
      <h2 id="similar-problem-title" className="modal-title form-modal-title">
        ขอโจทย์คล้ายกัน
      </h2>
      <p className="form-modal-subtitle">โจทย์ต้นทาง: {problem.text || "โจทย์นี้"}</p>
      <form className="ui-stack" onSubmit={handleSubmit}>
        <div className="ui-field">
          <span className="ui-field-label">ระดับความยาก</span>
          <VariationSelect value={variation} onChange={setVariation} disabled={submitting} />
        </div>

        <Textarea
          label="คำแนะนำเพิ่มเติม (ไม่บังคับ)"
          placeholder="เช่น ใช้เศษส่วนแทนทศนิยม"
          value={steer}
          onChange={(e) => setSteer(e.target.value)}
          maxLength={500}
          rows={2}
          disabled={submitting}
        />

        <div className="ui-field">
          <span className="ui-field-label">ความละเอียดของ AI</span>
          <EffortSelect value={effort} onChange={setEffort} options={SIMILAR_EFFORT_OPTIONS} disabled={submitting} />
        </div>

        {error ? (
          <p className="form-field-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="classroom-settings-actions">
          <button type="button" className="ui-btn ui-btn-outline" onClick={onClose} disabled={submitting}>
            ยกเลิก
          </button>
          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? "กำลังส่ง…" : "สร้างโจทย์ใหม่"}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}
