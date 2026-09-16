import { useEffect, useRef, useState } from 'react';
import { Eyedropper } from '@phosphor-icons/react';
import Modal from './Modal';
import Spinner from './Spinner';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { normalizeUrl } from '../reader';

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Fetch the page, read a theme out of it, and put it in the studio.
   * Resolves with the notes on what was read and what was not — the honest
   * part of the feature, so it is shown rather than summarised away.
   */
  onSniff: (url: string, onProgress: (msg: string) => void) => Promise<string[]>;
}

/**
 * Paste the address of an article, get its typesetting as a theme.
 *
 * The dialog stays open on success to show what came across: a sniffed theme
 * is a starting point, and the difference between "read off the page" and
 * "kept from the preset" is the first thing worth knowing before tuning it.
 *
 * Like the import dialog, the field fills itself from the clipboard — the
 * sequence is always copy-a-link-then-come-here — and that read goes through
 * Rust, because WebKit answers the WebView's own clipboard read with a paste
 * confirmation popup.
 */
export default function SniffThemeDialog({ open, onClose, onSniff }: Props) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setProgress('');
    setNotes(null);
    void readText()
      .then((text) => {
        if (normalizeUrl(text ?? '')) setUrl((text ?? '').trim());
      })
      .catch(() => undefined)
      .finally(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
  }, [open]);

  const target = normalizeUrl(url);

  const run = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    setNotes(null);
    setProgress('正在打开文章…');
    try {
      setNotes(await onSniff(target, setProgress));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      className="sniff-modal"
      initialFocus={inputRef}
      onSubmit={() => void run()}
      title={
        <>
          <Eyedropper size={15} weight="bold" />
          扒一个主题
        </>
      }
      foot={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {notes ? '去调' : '取消'}
          </button>
          <button className={`btn primary ${busy ? 'busy' : ''}`} type="submit" disabled={!target || busy} aria-busy={busy}>
            {busy && <Spinner />}
            {notes ? '再扒一篇' : '开始扒'}
          </button>
        </>
      }
    >
      <label className="field">
        <span>文章链接</span>
        <input
          ref={inputRef}
          type="text"
          value={url}
          placeholder="https://mp.weixin.qq.com/s/…"
          spellCheck={false}
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <p className="form-hint">
        只取排版：纸色、字号行距、标题装饰、引用形状、强调色。文章的文字和图片都不会拿过来。
        用图片做的标题和花饰扒不下来，扒完在主题工坊里接着调。
      </p>

      {progress && <p className="form-progress">{progress}</p>}
      {error && <p className="form-error">{error}</p>}

      {notes && (
        <div className="sniff-notes">
          <span className="eyebrow">扒到了什么</span>
          <ul>
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <p className="form-hint">主题已经建好并打开了工坊，右边可以接着改。</p>
        </div>
      )}
    </Modal>
  );
}
