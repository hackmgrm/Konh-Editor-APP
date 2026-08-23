import { FolderOpen, WarningCircle } from '@phosphor-icons/react';

interface Props {
  /** Why opening failed; null on a first run that has never picked one */
  error: string | null;
  onChoose: () => void;
}

/**
 * The screen standing in front of everything until a workspace exists.
 *
 * It also takes the chance to explain that a workspace is just a folder —
 * that is the whole contract between this app and a command-line agent, and
 * knowing it is what makes someone think to open a claude / codex in that
 * directory, or to git init it.
 */
export default function VaultGate({ error, onChoose }: Props) {
  return (
    <div className="vault-gate">
      <div className="vault-gate-card">
        <div className="vault-gate-mark" aria-hidden="true">火</div>
        <h1>选一个工作区</h1>
        {error ? (
          <p className="vault-gate-error">
            <WarningCircle size={16} weight="fill" />
            {error}
          </p>
        ) : null}
        <p>
          草稿和图片都直接存成这个文件夹里的普通文件，不放在浏览器里 ——
          换台机器把文件夹带走就行。
        </p>
        <pre className="vault-gate-tree">
{`工作区/
├── 随便怎么放.md   任意层级的 .md 点开就能编辑
├── 系列/第一篇.md  文件夹随你建，左边就是它的真实样子
└── images/         粘贴的图默认落这儿`}
        </pre>
        <p>
          因为就是普通文件，你可以在这个目录里开一个 claude 或 codex 让它改稿，
          这边会实时跟着变；也建议 <code>git init</code> 一下，改坏了能退回去。
        </p>
        <button type="button" className="vault-gate-btn" onClick={onChoose}>
          <FolderOpen size={18} weight="fill" />
          选择文件夹
        </button>
        <p className="vault-gate-hint">
          空文件夹也行。目录结构由你自己定，应用不往里塞任何配置文件。
        </p>
      </div>
    </div>
  );
}
