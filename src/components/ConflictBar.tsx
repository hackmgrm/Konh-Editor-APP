import { WarningCircle } from '@phosphor-icons/react';
import type { Conflict, Draft } from '../store/useVault';

interface Props {
  /** Draft id → conflict detail */
  conflicts: Record<string, Conflict>;
  drafts: Draft[];
  /** Overwrite the in-memory copy with what is on disk */
  onTakeDisk: (id: string) => void;
  /** Keep the local copy; the next save writes it back over the disk version */
  onKeepMine: (id: string) => void;
}

/**
 * The "someone else edited this too" bar.
 *
 * It only appears when *both* sides changed: with no unsaved local edits, an
 * external change is followed silently. There is deliberately no automatic
 * merge — both versions were written by someone who meant them, and guessing
 * wrong means throwing away somebody's work. Better to lay it out and let a
 * person decide.
 */
export default function ConflictBar({ conflicts, drafts, onTakeDisk, onKeepMine }: Props) {
  const items = Object.values(conflicts);
  if (!items.length) return null;

  return (
    <div className="conflict-bar">
      {items.map((c) => {
        const name = drafts.find((d) => d.id === c.id)?.name ?? c.id;
        return (
          <div key={c.id} className="conflict-row">
            <WarningCircle size={16} weight="fill" />
            <span className="conflict-text">
              「{name}」在工作区里被改过了，你这边也有没保存的修改
            </span>
            <button type="button" onClick={() => onKeepMine(c.id)}>
              保留我的
            </button>
            <button type="button" className="ghost" onClick={() => onTakeDisk(c.id)}>
              用磁盘上的
            </button>
          </div>
        );
      })}
    </div>
  );
}
