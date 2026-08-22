'use client';
import { useEffect, useRef } from 'react';

/**
 * A dialog, done once.
 *
 * `CityPicker` hand-rolled one in inline styles — a fixed overlay, a card, a Close
 * button — with no Escape handling, no focus management and nothing telling a
 * screen reader it was a dialog. This is the second thing on the site that needs
 * one, which is the point at which a second copy stops being pragmatic.
 *
 * What the inline version was missing, and why each matters:
 *
 *   - Escape closes it. A modal you can only leave by finding a button is a trap on
 *     a phone, where the button may be below the fold of a scrolled overlay.
 *   - Focus moves in on open and returns to the trigger on close, so a keyboard
 *     user is not dumped at the top of the document.
 *   - Background scroll is locked. Otherwise the page behind slides under the
 *     overlay and the reader loses their place in it.
 *   - `role="dialog"` and `aria-modal`, so it is announced as one rather than as a
 *     stray region.
 *
 * Deliberately not `<dialog>`: its backdrop styling and top-layer behaviour are
 * still inconsistent enough across the browsers this market uses that the
 * behaviour would vary by device.
 */
export function Modal({
  title, onClose, children, labelledBy,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  labelledBy?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  /*
   * Every caller passes `onClose` as an inline arrow function - the natural,
   * idiomatic way to write it, and not something callers should have to avoid.
   * That means a NEW function identity on every render of the caller, and this
   * effect used to depend on `[onClose]` directly: typing into ANY input inside
   * the modal re-renders the caller, which re-renders this with a new `onClose`,
   * which made the effect tear down and set up again on every keystroke - the
   * cleanup calls `restoreTo.current?.focus?.()`, so focus visibly jumped OUT of
   * the field being typed into after every single character. A ref keeps the
   * escape handler reading the latest `onClose` without the effect itself
   * depending on its identity.
   */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    panel.current?.focus();

    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('keydown', onKey);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      restoreTo.current?.focus?.();
    };
  }, []);   // mount/unmount only - see comment above

  return (
    <div className="modal-back" onClick={onClose}>
      <div
        className="modal-panel"
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : title}
        aria-labelledby={labelledBy}
        // A click inside must not reach the backdrop's close handler.
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3 id={labelledBy}>{title}</h3>
          <button className="btn outline sm" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}
