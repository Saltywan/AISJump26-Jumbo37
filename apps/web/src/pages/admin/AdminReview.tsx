/* Every global problem waiting on a decision, across every book — the screen
 * bulk import needs that a single section's page didn't: adding forty
 * questions at once means an admin reviews them later, in one place, not
 * one at a time right after generating each.
 *
 * No dedicated endpoint for this — it's GET /sections/{id}/problems, called
 * once per global section and filtered to `ready` client-side. Fine at the
 * scale a POC's global library actually reaches; the first sign it isn't
 * (many sections, or slow enough to notice) is also the sign a real
 * "GET /problems?status=ready" endpoint has earned its keep.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AppShell } from "../../components/AppShell";
import { PageHeader } from "../../components/ui";
import { ProblemArtifact } from "../../components/ProblemArtifact";
import { useSession } from "../../lib/session";
import { api, type ApiProblem, type ApiSection } from "../../lib/api";

export default function AdminReview() {
  const { user } = useSession();
  const [rows, setRows] = useState<{ section: ApiSection; problem: ApiProblem }[]>([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    const sections = await api.globalSections();
    const lists = await Promise.all(
      sections.map(async (section) => ({ section, problems: await api.sectionProblems(section.id) }))
    );
    const waiting = lists.flatMap(({ section, problems }) =>
      problems.filter((p) => p.page?.status === "ready").map((problem) => ({ section, problem }))
    );
    setRows(waiting);
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, []);

  if (!user) return null;
  if (user.role !== "admin") {
    return (
      <AppShell>
        <p className="classroom-empty">หน้านี้สำหรับผู้ดูแลระบบเท่านั้น</p>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader title="คิวตรวจโจทย์" subtitle="โจทย์ที่สร้างเสร็จแล้วและรอการอนุมัติก่อนเผยแพร่" />

      {loading ? (
        <p className="classroom-empty">กำลังโหลด…</p>
      ) : rows.length === 0 ? (
        <p className="classroom-empty">ไม่มีโจทย์รอตรวจในตอนนี้</p>
      ) : (
        <div className="library-problem-grid">
          {rows.map(({ section, problem }) => (
            <div key={problem.id} className="admin-review-row">
              <Link to={`/admin/section/${section.id}`} className="admin-review-section-link">
                {section.title}
              </Link>
              <ProblemArtifact problem={problem} isAdmin isMine={false} onChanged={refresh} />
            </div>
          ))}
        </div>
      )}
    </AppShell>
  );
}
