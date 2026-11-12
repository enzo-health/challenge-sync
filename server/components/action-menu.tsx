// A "⋮" button that opens a short list of actions for one table row.
//
// The list is placed with `position: fixed` from the button's position on screen, not inside the
// row: tables sit in panels that scroll sideways (`overflow-x: auto`), which would cut off a
// menu opening below the last rows. Being fixed, it would drift if the page moved under it, so it
// closes on scroll and resize instead of following.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

export type MenuAction = {
  label: string;
  onSelect: () => void;
  /** Shown in the danger colour (deleting, for instance). */
  danger?: boolean;
  disabled?: boolean;
};

export function ActionMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = (refocus: boolean) => {
    setOpen(false);
    setPlace(null);
    if (refocus) buttonRef.current?.focus();
  };

  // Measure after the menu renders (hidden), then place it: below the button and right-aligned to
  // it, or above when there is no room below, and never off the left or right edge.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !menuRef.current) return;
    const button = buttonRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const gap = 4;
    const below = button.bottom + gap;
    const top = below + menu.height > window.innerHeight - 8 ? Math.max(8, button.top - gap - menu.height) : below;
    const left = Math.min(Math.max(8, button.right - menu.width), window.innerWidth - menu.width - 8);
    setPlace({ top, left });
  }, [open]);

  // Focus the first item once the menu is placed (a hidden element cannot take focus), so the
  // keyboard lands inside it.
  useEffect(() => {
    if (place) menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [place]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      }
    };
    const onMove = () => close(false);
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    // Capture, so a scroll inside the table's own scrolling panel closes it too.
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  // Up and down arrows move between the items, as in a native menu; Tab leaves the menu.
  const onMenuKey = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <>
      <button
        ref={buttonRef}
        className="menu-button"
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        ⋮
      </button>
      {open && (
        <div
          ref={menuRef}
          className="row-menu"
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          onBlur={(e) => {
            // Tabbing out of the menu closes it. (A click elsewhere is handled by the listener
            // above; it may land on something that takes no focus, leaving `relatedTarget` empty.)
            const next = e.relatedTarget as Node | null;
            if (next && !menuRef.current?.contains(next) && next !== buttonRef.current) close(false);
          }}
          style={place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: "hidden" }}
        >
          {actions.map((action) => (
            <button
              key={action.label}
              className={action.danger ? "danger" : undefined}
              type="button"
              role="menuitem"
              disabled={action.disabled}
              onClick={() => {
                close(false);
                action.onSelect();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
