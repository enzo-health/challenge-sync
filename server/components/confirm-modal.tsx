// The app's one confirmation dialog, in place of `window.confirm`: the browser's box cannot say
// which button is the dangerous one, cannot show why the server refused, and looks different in
// every browser.
import { useEffect, useRef, type ReactNode } from "react";

export function ConfirmModal({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  /** One or two plain sentences saying who it affects and what will happen. */
  children: ReactNode;
  confirmLabel: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
  /** The action is running: both buttons wait, and Escape does nothing. */
  busy?: boolean;
  /** The server's reason the action failed, shown inside the dialog. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Cancel has focus by default, so Enter on an unread dialog never does the dangerous thing.
  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="modal confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <h3 id="confirm-title">{title}</h3>
        <div className="confirm-body">{children}</div>
        {error && <div className="notice err">{error}</div>}
        <div className="confirm-actions">
          <button ref={cancelRef} className="btn ghost" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className={danger ? "btn danger" : "btn"} type="button" disabled={busy} onClick={onConfirm}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
