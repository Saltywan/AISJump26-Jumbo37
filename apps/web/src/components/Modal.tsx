/* The one bit of dialog behaviour every modal in the app needs and none of
   them should reimplement: trap focus inside, put focus somewhere sane on
   open, cycle Tab/Shift+Tab at the edges, close on Escape, and give focus
   back to whatever had it once the dialog goes away.
 *
 * This used to be copied whole into ClassroomSettings.tsx's delete
 * confirmation (see its git history) — fine for one dialog, but the
 * classroom/lesson creation forms below need the exact same contract with a
 * different default focus target (the first field, not a "safe" cancel
 * button), and a third copy is where "same contract" quietly drifts. Lives
 * here once; ClassroomSettings.tsx's dialog and both creation modals all use
 * it now. */
import { useEffect, useRef, type ReactNode } from "react";

/** Attach the returned ref to the dialog's outermost element.
 *  `initialFocusRef`, when given, is what receives focus on open (the delete
 *  confirmation wants its Cancel button, not the danger action); otherwise
 *  the first focusable element inside the dialog gets it (a form's first
 *  field, which is what a teacher expects to be able to type into right
 *  away). */
export function useDialogFocusTrap(
  onClose: () => void,
  initialFocusRef?: React.RefObject<HTMLElement | null>
) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const target =
      initialFocusRef?.current ??
      dialogRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
    target?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return dialogRef;
}

/** The scrim + card shell (Figma node 60:7009's chrome), reused for any
 *  dialog rather than just the delete confirmation it was drawn for.
 *  `className` extends `modal-card` for a dialog whose content doesn't fit
 *  the centered warning-dialog layout (see creation-modals.css's
 *  `form-modal-card`). */
export function ModalDialog({
  onClose,
  initialFocusRef,
  labelledBy,
  describedBy,
  role = "dialog",
  className = "",
  children,
}: {
  onClose: () => void;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  labelledBy: string;
  describedBy?: string;
  role?: "dialog" | "alertdialog";
  className?: string;
  children: ReactNode;
}) {
  const dialogRef = useDialogFocusTrap(onClose, initialFocusRef);
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`modal-card ${className}`}
        ref={dialogRef}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
      >
        {children}
      </div>
    </div>
  );
}
