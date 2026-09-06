/* One bad check row used to blank the entire teacher console.
 *
 * ReportSummary threw on a report whose shape it did not expect, and with
 * nothing catching it React unmounted the whole tree: no page, no sidebar, no
 * way back except a reload — and no clue what happened. The report is the least
 * important thing on that screen; it must never be able to take the page with
 * it.
 *
 * Deliberately not a global boundary. Wrapping the app would hide crashes
 * everywhere and make them harder to find; this wraps the one panel whose input
 * is data written by another process, in a shape this app does not control. */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** What failed, in a teacher's terms — shown in place of the panel. */
  label: string;
}

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Still shout about it. A swallowed crash is a crash nobody fixes.
    console.error(`[${this.props.label}] render failed`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="panel-error">
          <p className="panel-error-title">{this.props.label}</p>
          <p className="panel-error-body">
            แสดงผลไม่สำเร็จ — ข้อมูลรายงานของหน้านี้ไม่อยู่ในรูปแบบที่คาดไว้
            <br />
            ส่วนอื่นของหน้ายังใช้งานได้ตามปกติ แต่<b>อย่าเผยแพร่หน้านี้จนกว่าจะตรวจด้วยตาเอง</b>
          </p>
          <code className="panel-error-detail">{String(this.state.error.message).slice(0, 160)}</code>
        </div>
      );
    }
    return this.props.children;
  }
}
