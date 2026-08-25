import { useEffect, useRef, useState } from 'react';
import { Globe, X } from '@phosphor-icons/react';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { getImportImages, normalizeUrl, setImportImages } from '../reader';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Workspace-relative directory the new draft lands in ('' = the root) */
  parent: string;
  /**
   * Do the import. Rejects with something worth showing; `onProgress` feeds the
   * line in the footer, since a page with thirty images takes a moment.
   */
  onImport: (url: string, withImages: boolean, onProgress: (msg: string) => void) => Promise<void>;
}

/**
 * Paste a link, get a draft.
 *
 * The field fills itself from the clipboard on open, because the sequence is
 * always the same: copy the address in a browser, come here. So the usual
 * visit is open-and-confirm, with nothing to type.
 *
 * That read goes through Rust rather than navigator.clipboard, and the
 * difference is the whole reason it is worth doing: WebKit answers the
 * WebView's own readText() with a "Paste" confirmation popup, so the
 * convenience cost one more click than typing would have. From the Rust side
 * there is no popup — see the clipboard plugin registered in lib.rs.
 *
 * Deliberately one field and one checkbox. Everything else the extractor could
 * be told — engines, selectors, timeouts — is a decision the user has no way to
 * make from here, and the answer that works for a news page works for a blog
 * post and a documentation page too (see reader.ts).
 */
export default function ImportUrlDialog({ open, onClose, parent, onImport }: Props) {
  const [url, setUrl] = useState('');
  const [withImages, setWithImages] = useState(getImportImages);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setProgress('');
    // Only a link goes in. Anything else on the clipboard is left alone and the
    // field stays empty, which is also what happens if the read fails outright
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const target = normalizeUrl(url);

  const run = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    setProgress('正在抓取正文…');
    try {
      await onImport(target, withImages, setProgress);
      setUrl('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const toggleImages = (on: boolean) => {
    setWithImages(on);
    setImportImages(on);
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="从链接导入"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>从链接导入</h2>
          <button className="modal-close" onClick={onClose} disabled={busy} aria-label="关闭">
            <X size={15} weight="bold" />
          </button>
        </header>

        <div className="modal-body">
          <section className="form-section">
            <div className="form-section-label">网页地址</div>
            <label className="field">
              <span>链接</span>
              <input
                ref={inputRef}
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void run();
                }}
                placeholder="https://…"
                spellCheck={false}
                disabled={busy}
              />
            </label>
            <p className="form-note">
              抓下来的是正文 —— 导航栏、侧边栏、推荐位、评论区都不会跟着进来。存成
              {parent ? <code>{parent}/</code> : '工作区根目录'}下的一篇新草稿，文件名就是文章标题。
            </p>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={withImages}
                onChange={(e) => toggleImages(e.target.checked)}
                disabled={busy}
              />
              <span>把正文里的图片一并存进工作区</span>
            </label>
            <p className="form-note">
              建议开着：图落到 <code>images/</code> 里就成了本地文件，之后复制、导长图、推草稿都不用再看
              对方图床的脸色。不开的话正文里留的还是外链。
            </p>
          </section>
        </div>

        <footer className="modal-foot">
          {error && <span className="form-error">{error}</span>}
          {busy && progress && <span className="form-progress">{progress}</span>}
          <button className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={() => void run()} disabled={busy || !target}>
            <Globe size={15} weight="bold" />
            {busy ? '导入中…' : '抓取并新建草稿'}
          </button>
        </footer>
      </div>
    </div>
  );
}
