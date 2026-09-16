import type { Icon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

interface Props {
  icon: Icon;
  /** One line saying what is not here */
  title: string;
  /** One line saying how it gets here. Never more than a sentence */
  hint?: ReactNode;
  /** The single thing to do about it, if there is one */
  action?: { label: string; onClick: () => void };
  /** Chips under the action — the agent panel offers example prompts this way */
  children?: ReactNode;
}

/**
 * Nothing here, said properly.
 *
 * Four places in the app had an empty state and all four were different: the
 * agent panel showed a 32%-opacity terminal glyph and no words at all, the
 * tree and the drafts box a bare grey sentence, the studio's search a bare
 * grey sentence in a different size. An empty region is the one moment the
 * interface has the reader's full attention and nothing to compete with, so
 * it is worth a shape: a small tinted disc, a statement, a way forward.
 *
 * The icon is drawn `regular` — this is a picture of a thing, not a control,
 * and at 18px inside a 40px disc a bold stroke reads as a warning sign.
 */
export default function EmptyState({ icon: Glyph, title, hint, action, children }: Props) {
  return (
    <div className="empty-state">
      <span className="empty-mark" aria-hidden="true">
        <Glyph size={18} weight="regular" />
      </span>
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
      {action && (
        <button type="button" className="btn empty-action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {children}
    </div>
  );
}
