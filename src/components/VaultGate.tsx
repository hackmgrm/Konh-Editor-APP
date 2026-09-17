import { FolderOpen, WarningCircle } from '@phosphor-icons/react';

interface Props {
  /** Why opening failed; null on a first run that has never picked one */
  error: string | null;
  onChoose: () => void;
}

/**
 * The screen standing in front of everything until a workspace exists.
 *
 * It is also the only screen a new user is guaranteed to see, so it is set as
 * a title page rather than as a dialog: the mark, the name, one line saying
 * what the app is for, and the single thing there is to do. Everything the old
 * copy explained about the folder contract — that a workspace is a plain
 * directory of plain files — is carried by the hint under the button; the rest
 * of it is discoverable the moment the workspace opens, and a wall of prose in
 * front of one button was never read.
 */
export default function VaultGate({ error, onChoose }: Props) {
  return (
    <div className="vault-gate">
      <div className="vault-gate-card">
        {/* Horizon mark, identical to the toolbar's, public/favicon.svg and the
            app icon. Fixed brand colors, not theme tokens. */}
        <span className="vault-gate-mark" aria-hidden="true">
          <svg viewBox="0 0 100 100">
            <rect width="100" height="100" rx="22" fill="#F1ECE3" />
            <path d="M18 58A32 32 0 0 1 82 58Z" fill="#C4482A" />
            <rect x="14" y="64" width="72" height="10" rx="5" fill="#6E2715" />
          </svg>
        </span>
        <h1>火星编辑器</h1>
        <p>写 Markdown，排成公众号文章。选一个文件夹当稿库开始。</p>
        {error ? (
          <p className="vault-gate-error">
            <WarningCircle size={16} weight="fill" />
            {error}
          </p>
        ) : null}
        <button type="button" className="btn primary vault-gate-btn" onClick={onChoose}>
          <FolderOpen size={18} weight="fill" />
          选择稿库文件夹
        </button>
        <p className="vault-gate-hint">稿子、图片都存成这个文件夹里的普通文件，随时能换</p>
      </div>
    </div>
  );
}
