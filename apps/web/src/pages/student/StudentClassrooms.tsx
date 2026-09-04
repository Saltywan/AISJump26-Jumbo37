/* Figma node 60:6926 "Classroom" — student home. Same shell and the same
 * Card/PageHeader/SectionTitle primitives as the teacher's classroom list
 * (src/pages/teacher/ClassroomList.tsx). The two differences from the teacher
 * screen are exactly what the brief calls out: no "สร้างห้องเรียน" button, and
 * the card action reads "ดูบทเรียน" instead of "ดูและสร้างสื่อการสอน".
 *
 * Reads the API when it is up (see useLiveClassrooms below), because the ids
 * that matter here are whatever the server issued — see lib/classroom.ts's
 * syncSeedToServer(), which gives the teacher's local "c-phys-4-1"-style seed
 * ids real server ids the first time the teacher opens their classroom list.
 * A student's own browser has its own, never-synced copy of that same local
 * seed, under the OLD ids — reading only lib/classroom.ts here would send a
 * student down a classroomId the server (and thus the teacher's published
 * lessons) has never heard of, which is exactly the two-device gap this pass
 * exists to close. Falls back to the local seed when the backend is down, so
 * the single-machine demo still works with no server at all. */
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { AppShell } from "../../components/AppShell";
import { Card, PageHeader, SectionTitle } from "../../components/ui";
import { useSession } from "../../lib/session";
import { lessonsOf, useClassroomStore } from "../../lib/classroom";
import { api, isLive } from "../../lib/api";
import angleSmallRightUrl from "../../icons/angle-small-right.svg";

interface LiveClassroom {
  id: string;
  name: string;
  lesson_count: number;
}

/** Polls the API for the classroom list, refreshing every few seconds so a
 *  classroom a teacher just created on another device shows up without a
 *  reload. Returns null when the backend is unreachable — the caller falls
 *  back to the local seed in that case, the same isLive() pattern lib/api.ts
 *  documents.
 *
 * GET /classrooms reports each classroom's TOTAL lesson count, published or
 * not — meant for the teacher's own list, where seeing draft work in progress
 * is the point. Showing that number here would tell a student "5 บทเรียน"
 * on a classroom with nothing published yet, which is exactly the kind of
 * thing this pass exists to stop implying, even though the lessons screen
 * one tap away gets it right. So this re-asks per classroom with
 * published_only=true and uses that count instead — more requests, but this
 * is a handful of classrooms in a demo, not a scale where it matters. */
function useLiveClassrooms(): LiveClassroom[] | null {
  const [rows, setRows] = useState<LiveClassroom[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (await isLive()) {
        try {
          const classrooms = await api.classrooms();
          const withPublishedCounts = await Promise.all(
            classrooms.map(async (c) => {
              try {
                const published = await api.lessons(c.id, true);
                return { id: c.id, name: c.name, lesson_count: published.length };
              } catch {
                return { id: c.id, name: c.name, lesson_count: 0 };
              }
            })
          );
          if (!cancelled) setRows(withPublishedCounts);
          return;
        } catch {
          /* fall through to offline */
        }
      }
      if (!cancelled) setRows(null);
    }
    void load();
    const t = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return rows;
}

export default function StudentClassrooms() {
  const { user } = useSession();
  const state = useClassroomStore();
  const live = useLiveClassrooms();

  if (!user) return <Navigate to="/login" replace />;

  const rows = live ?? state.classrooms.map((c) => ({ id: c.id, name: c.name, lesson_count: lessonsOf(state, c.id).length }));

  return (
    <AppShell>
      <PageHeader title={`สวัสดี, ${user.name}`} subtitle="เลือกห้องเรียนเพื่อเริ่มเรียนรู้และทบทวนบทเรียน" />

      <div className="ui-stack">
        <SectionTitle>ห้องเรียนของฉัน</SectionTitle>
        {rows.length === 0 ? (
          <p className="classroom-empty">ยังไม่มีห้องเรียน</p>
        ) : (
          rows.map((c) => (
            <Card
              key={c.id}
              to={`/s/c/${c.id}`}
              title={c.name}
              meta={`${c.lesson_count} บทเรียน`}
              action={
                <span className="ui-btn ui-btn-quiet">
                  ดูบทเรียน
                  <img src={angleSmallRightUrl} alt="" width={16} height={16} />
                </span>
              }
            />
          ))
        )}
      </div>
    </AppShell>
  );
}
