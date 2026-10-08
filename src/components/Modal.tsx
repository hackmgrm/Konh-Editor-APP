import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { X } from '@phosphor-icons/react';
import { EXIT_MODAL, usePresence } from '../usePresence';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Heading text. A node, because two of the dialogs put an icon in front of it */
  title: ReactNode;
  /** Something before the heading — the drafts box puts its "back" button there */
  headLead?: ReactNode;
  /** Something after the heading, before the close button (a count, a hint) */
  headExtra?: ReactNode;
  /** The 720px variant (the drafts box, which lists articles) */
  wide?: boolean;
  /** Extra classes on the `.modal` box itself */
  className?: string;
  /**
   * Work is in flight: Esc, the backdrop and the close button all stop
   * dismissing. A push or a download half-finished looks cancelled if the
   * dialog reporting it disappears.
   */
  busy?: boolean;
  /** What to focus on open. Without it the first field, or failing that the
   *  primary button, takes focus */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Given: body and footer are wrapped in a form, so Enter in any field submits */
  onSubmit?: () => void;
  children: ReactNode;
  foot?: ReactNode;
}

/** Everything that can hold focus inside the box, in tab order */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The shell all six dialogs sit in.
 *
 * Each of them used to carry its own copy of the same four things — backdrop,
 * Esc listener, `{open && …}`, a close button — and each copy was a little
 * different: some closed on Esc while busy, some had no `aria-modal`, none of
 * them animated shut or gave focus back to the button that opened them. One
 * shell means the answer is the same everywhere, and the dialogs are left with
 * only the part that is actually theirs.
 *
 * Focus is the substance here. On open it goes to the first field (the thing
 * you came to type in); Tab cycles inside the box rather than wandering into
 * the editor behind it; on close it returns to the control that opened the
 * dialog, so the keyboard is back where it started.
 */
export default function Modal({
  open,
  onClose,
  title,
  headLead,
  headExtra,
  wide,
  className,
  busy,
  initialFocus,
  onSubmit,
  children,
  foot,
}: Props) {
  const { mounted, state } = usePresence(open, EXIT_MODAL);
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  /** Who had focus before this opened, so it can be handed back */
  const openerRef = useRef<HTMLElement | null>(null);
  /** Latest onClose without re-registering the key listener every render */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // Remember the opener the moment the dialog is asked for, and restore it
  // once the box is really gone (after the exit animation, or the focus ring
  // lands on a button that is still covered by a fading backdrop)
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
  }, [open]);

  useEffect(() => {
    if (mounted) return;
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener?.isConnected) opener.focus();
  }, [mounted]);

  // Initial focus: what the caller named, else the first field, else the
  // primary button. Deliberately not the close button — landing on 关闭 means
  // a stray Return dismisses the dialog you just opened.
  //
  // `mounted` is a dependency because usePresence flips it in an effect, one
  // render after `open` goes true: on that first commit there is no box yet.
  useEffect(() => {
    if (!open || !mounted) return;
    const box = boxRef.current;
    if (!box) return;
    const target =
      initialFocus?.current ??
      box.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), textarea:not([disabled])') ??
      box.querySelector<HTMLElement>('.modal-foot .btn.primary');
    target?.focus();
    if (target instanceof HTMLInputElement && target.type === 'text') target.select();
    // Only when the dialog opens: refocusing on every keystroke would fight
    // the user for the caret
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (busyRef.current) return;
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const box = boxRef.current;
      if (!box) return;
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // Wrap at both ends, and catch the case where focus escaped the box
      // entirely (a click on the backdrop leaves it on <body>)
      if (e.shiftKey && (active === first || !box.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !box.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    // Capture, so a field's own Esc handling does not get there first
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  if (!mounted) return null;

  const body = (
    <>
      <div className="modal-body">{children}</div>
      {foot && <footer className="modal-foot">{foot}</footer>}
    </>
  );

  return (
    <div
      className="modal-backdrop"
      data-state={state}
      onMouseDown={() => !busy && onClose()}
    >
      <div
        ref={boxRef}
        className={`modal${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`}
        data-state={state}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          {headLead}
          <h2 id={titleId}>{title}</h2>
          {headExtra}
          <button className="modal-close" onClick={onClose} disabled={busy} aria-label="关闭">
            <X size={16} weight="regular" />
          </button>
        </header>
        {onSubmit ? (
          // `display: contents` on the form: body and foot stay direct flex
          // children of .modal, so nothing about the layout changes — the form
          // exists only so Enter in a field submits
          <form
            className="modal-form"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            {body}
          </form>
        ) : (
          body
        )}
      </div>
    </div>
  );
}
