import { useEffect, useState } from 'react';
import { ArrowClockwise, ArrowSquareOut, CheckCircle, DownloadSimple, X } from '@phosphor-icons/react';
import { IS_MAC } from '../platform';
import {
  RELEASES_URL,
  appVersion,
  downloadAndInstall,
  restartIntoUpdate,
  skipVersion,
  useUpdate,
} from '../store/updater';

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Bytes as something a person reads while watching a progress bar */
function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** `2026-08-24 10:03:22 +0.00` (what the release carries) → `2026-08-24` */
function shortDate(raw: string | null): string {
  if (!raw) return '';
  const day = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '';
}

/**
 * The update dialog: what is new, and the one button that installs it.
 *
 * Deliberately not shown by itself. The launch check only lights the pill in
 * the toolbar; this opens when that pill is pressed, or from 设置 → 关于. An
 * editor that interrupts you to talk about itself is an editor you close.
 *
 * Every phase after 下载并安装 is one-way and slow enough to be visible, so the
 * dialog stops being dismissable once bytes are moving: closing it would leave
 * a download running with nothing on screen that says so.
 */
export default function UpdateDialog({ open, onClose }: Props) {
  const state = useUpdate();
  const [installed, setInstalled] = useState('');

  useEffect(() => {
    void appVersion().then(setInstalled);
  }, []);

  const busy = state.phase === 'downloading';

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  // Every phase that knows about a release carries it under the same key; the
  // three that do not (idle / checking / current) simply have no `info`
  const info = 'info' in state ? state.info : null;

  const pct =
    state.phase === 'downloading' && state.total
      ? Math.min(100, Math.round((state.received / state.total) * 100))
      : null;

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="应用更新"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>{state.phase === 'ready' ? '更新已就绪' : info ? '有新版本' : '检查更新'}</h2>
          <button className="modal-close" onClick={onClose} disabled={busy} aria-label="关闭">
            <X size={15} weight="bold" />
          </button>
        </header>

        <div className="modal-body">
          <div className="update-versions">
            <span className="update-ver from">{installed ? `v${installed}` : '当前版本'}</span>
            {info && (
              <>
                <span className="update-arrow" aria-hidden="true">
                  →
                </span>
                <span className="update-ver to">v{info.version}</span>
                {shortDate(info.date) && <span className="update-date">{shortDate(info.date)}</span>}
              </>
            )}
          </div>

          {state.phase === 'downloading' && (
            <div className="update-bar" role="progressbar" aria-valuenow={pct ?? undefined}>
              <span
                className={`update-bar-fill ${pct === null ? 'indeterminate' : ''}`}
                style={pct === null ? undefined : { width: `${pct}%` }}
              />
            </div>
          )}

          {state.phase === 'checking' && (
            <p className="form-note">
              <span className="spinner" aria-hidden="true" /> 正在向发布页询问…
            </p>
          )}

          {state.phase === 'current' && (
            <p className="form-ok">
              <CheckCircle size={13} weight="fill" />
              已经是最新版本。
            </p>
          )}

          {info?.notes && (
            <section className="form-section">
              <div className="form-section-label">更新内容</div>
              <pre className="update-notes">{info.notes}</pre>
            </section>
          )}

          {state.phase === 'ready' && (
            <p className="form-note">
              新版本已经装好了。重启之后生效 —— 未保存的改动会先落盘，工作区不受影响。
            </p>
          )}

          {state.phase === 'available' && !IS_MAC && (
            <p className="form-note">
              安装过程由系统安装程序接管，期间应用会自行退出并重新打开。
            </p>
          )}

          {state.phase === 'failed' && (
            <>
              <p className="form-error">{state.message}</p>
              <p className="form-note">
                也可以直接去
                <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className="ext-link">
                  发布页 <ArrowSquareOut size={11} weight="bold" />
                </a>
                手动下载安装包。
              </p>
            </>
          )}
        </div>

        <footer className="modal-foot">
          {state.phase === 'downloading' && (
            <span className="form-progress">
              {pct === null
                ? `正在下载… ${mb(state.received)}`
                : `正在下载… ${pct}%（${mb(state.received)} / ${mb(state.total!)}）`}
            </span>
          )}

          {state.phase === 'available' && (
            <button
              className="btn"
              onClick={() => {
                // Dismissing is an answer, not a step — there is nothing left
                // to look at here, and the toolbar pill goes out with it
                skipVersion(state.info.version);
                onClose();
              }}
            >
              忽略这个版本
            </button>
          )}

          {state.phase === 'ready' ? (
            <>
              <button className="btn" onClick={onClose}>
                下次启动再说
              </button>
              <button className="btn primary" onClick={() => void restartIntoUpdate()}>
                <ArrowClockwise size={14} weight="bold" />
                立即重启
              </button>
            </>
          ) : state.phase === 'failed' ? (
            <>
              <button className="btn" onClick={onClose}>
                关闭
              </button>
              {state.info && (
                <button className="btn primary" onClick={() => void downloadAndInstall()}>
                  重试
                </button>
              )}
            </>
          ) : (
            <>
              <button className="btn" onClick={onClose} disabled={busy}>
                {state.phase === 'available' ? '稍后' : '关闭'}
              </button>
              {state.phase === 'available' && (
                <button className="btn primary" onClick={() => void downloadAndInstall()}>
                  <DownloadSimple size={14} weight="bold" />
                  下载并安装
                </button>
              )}
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
