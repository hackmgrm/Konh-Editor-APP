import { useCallback, useEffect, useState } from 'react';
import { ArrowSquareOut, CaretLeft, GearSix, PencilSimple, Tray } from '@phosphor-icons/react';
import Modal from './Modal';
import EmptyState from './EmptyState';
import Spinner from './Spinner';
import { openExternal } from '../external';
import { isConfigured, fetchDraft, listDrafts, type DraftItem, type DraftNewsItem } from '../wechat';
import type { DraftTarget } from '../publish';
import { useWechatConfig } from '../store/wechatConfig';

/** One page's worth. Ten rows fit the dialog without turning it into a scroll
 *  marathon, and the drafts box is browsed, not searched */
const PAGE_SIZE = 10;

interface Props {
  open: boolean;
  onClose: () => void;
  /** Chosen draft: the push dialog reopens pointed at it */
  onPickTarget: (target: DraftTarget, digest: string) => void;
  onOpenSettings: () => void;
}

/** A draft may hold several articles; the list is flat, so each article is a row */
interface Row {
  mediaId: string;
  updateTime: number;
  index: number;
  count: number;
  article: DraftNewsItem;
}

function flatten(items: DraftItem[]): Row[] {
  return items.flatMap((item) =>
    item.articles.map((article, index) => ({
      mediaId: item.media_id,
      updateTime: item.update_time,
      index,
      count: item.articles.length,
      article,
    })),
  );
}

/** WeChat hands back seconds; a bare epoch number tells the reader nothing */
function formatTime(seconds: number): string {
  if (!seconds) return '';
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The wrapper the stored body is dropped into.
 *
 * It used to be a hard-coded white page with near-black ink, which in dark
 * mode was a rectangle of daylight in the middle of the dialog. The two
 * colours come off the article theme instead — the same custom properties the
 * phone chrome reads — so the frame matches the paper the preview is drawn on.
 */
function frameDoc(html: string): string {
  const css = getComputedStyle(document.documentElement);
  const bg = css.getPropertyValue('--art-bg').trim() || '#ffffff';
  const ink = css.getPropertyValue('--art-ink').trim() || '#1c1c1e';
  return (
    `<!doctype html><meta charset="utf-8"><style>` +
    `body{margin:0;padding:16px;font:15px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;` +
    `color:${ink};background:${bg}}img{max-width:100%;height:auto}</style>${html}`
  );
}

/**
 * The drafts box, read back from WeChat.
 *
 * Two things it is for. Seeing what is actually up there — the drafts box is
 * otherwise only visible inside the WeChat console, so after a few pushes it is
 * genuinely unclear which version of an article is the one sitting there. And
 * picking one to overwrite: pushing a revised article used to leave a second
 * copy behind, and cleaning those up by hand in the console was the whole
 * reason draft/update exists.
 *
 * Bodies are not in the listing (no_content=1) — they are most of the response
 * and none of them is shown. Pressing 看正文 fetches that one draft in full.
 */
export default function DraftBoxDialog({ open, onClose, onPickTarget, onOpenSettings }: Props) {
  const cfg = useWechatConfig();
  const configured = isConfigured(cfg);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /**
   * Which row's 看正文 is out.
   *
   * It used to be the same `busy` the page fetch uses, which disabled all ten
   * buttons and told you nothing about which one you pressed. A fetch is a
   * property of the row it was asked from.
   */
  const [openingRow, setOpeningRow] = useState<string | null>(null);
  /** Non-null while reading one body; the list steps aside for it */
  const [viewing, setViewing] = useState<{ title: string; html: string } | null>(null);

  const load = useCallback(
    async (at: number) => {
      setBusy(true);
      setError('');
      try {
        const page = await listDrafts(cfg, at, PAGE_SIZE);
        setTotal(page.total);
        setRows(flatten(page.items));
        setOffset(at);
      } catch (err) {
        setRows([]);
        setError(err instanceof Error ? err.message : '读取草稿箱失败');
      } finally {
        setBusy(false);
      }
    },
    [cfg],
  );

  // Fetch on open, and again on reopen: the box may have changed in the console
  useEffect(() => {
    if (!open) return;
    setViewing(null);
    if (configured) void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, configured]);

  // Esc backs out of a body first, so it does not close the whole dialog from
  // under someone who only meant to leave the article. Registered in capture
  // and stopped here, so the shell's own Esc never sees it while a body is up.
  useEffect(() => {
    if (!open || !viewing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setViewing(null);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, viewing]);

  const openBody = async (row: Row) => {
    const key = `${row.mediaId}:${row.index}`;
    setOpeningRow(key);
    setError('');
    try {
      const articles = await fetchDraft(cfg, row.mediaId);
      const article = articles[row.index] ?? articles[0];
      if (!article) throw new Error('这篇草稿没有正文');
      setViewing({ title: article.title || '（无标题）', html: article.content });
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取正文失败');
    } finally {
      setOpeningRow(null);
    }
  };

  const pick = (row: Row) => {
    onPickTarget(
      {
        mediaId: row.mediaId,
        index: row.index,
        thumbMediaId: row.article.thumb_media_id,
        title: row.article.title,
      },
      row.article.digest,
    );
  };

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={viewing ? viewing.title : '草稿箱'}
      headLead={
        viewing && (
          <button className="modal-close" onClick={() => setViewing(null)} aria-label="返回列表">
            {/* A caret, not an arrow: it sits a few pixels from the dialog's
                own ✕ and two full-length arrows side by side read as a pair of
                equals rather than "back out of this one thing" */}
            <CaretLeft size={16} weight="regular" />
          </button>
        )
      }
      headExtra={!viewing && total > 0 && <span className="form-hint">共 {total} 篇</span>}
      foot={
        <>
          {error && <span className="form-error">{error}</span>}
          {(busy || openingRow) && !error && <span className="form-progress">正在读取…</span>}
          {!viewing && (
            <>
              <button className="btn" onClick={() => void load(0)} disabled={busy}>
                刷新
              </button>
              <button className="btn" onClick={() => void load(offset - PAGE_SIZE)} disabled={busy || offset <= 0}>
                上一页
              </button>
              <span className="form-hint pager">
                {page} / {pages}
              </span>
              <button
                className="btn"
                onClick={() => void load(offset + PAGE_SIZE)}
                disabled={busy || offset + PAGE_SIZE >= total}
              >
                下一页
              </button>
            </>
          )}
          <button className="btn" onClick={viewing ? () => setViewing(null) : onClose}>
            {viewing ? '返回' : '关闭'}
          </button>
        </>
      }
    >
      {viewing ? (
        /* The body comes back from WeChat as a whole HTML fragment with its
           own inline styles. It goes into a sandboxed frame rather than into
           this document: no script runs, and its styles cannot leak out and
           repaint the app around it. */
        <iframe
          className="draft-preview"
          title="草稿正文"
          sandbox=""
          srcDoc={frameDoc(viewing.html)}
        />
      ) : !configured ? (
        <section className="form-section">
          <p className="form-note">还没填公众号凭据，读不到草稿箱。</p>
          <button type="button" className="btn" onClick={onOpenSettings}>
            <GearSix size={14} weight="regular" />
            去填凭据
          </button>
        </section>
      ) : (
        <div className="draft-list">
          {busy && !rows.length && (
            /* Six of them: one page is ten rows, and six fills the dialog's
               minimum height without pretending to know how many are coming */
            <div className="draft-skeletons" aria-hidden="true">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div className="draft-row skeleton-row" key={i}>
                  <div className="draft-cover skeleton" />
                  <div className="draft-main">
                    <div className="skeleton skeleton-line title" />
                    <div className="skeleton skeleton-line meta" />
                  </div>
                </div>
              ))}
            </div>
          )}
          {rows.map((row) => (
            <div className="draft-row" key={`${row.mediaId}:${row.index}`}>
              {row.article.thumb_url ? (
                <img className="draft-cover" src={row.article.thumb_url} alt="" loading="lazy" />
              ) : (
                <div className="draft-cover empty" aria-hidden="true" />
              )}
              <div className="draft-main">
                <div className="draft-title">
                  {row.count > 1 && <span className="draft-index">{row.index + 1}</span>}
                  {row.article.title || '（无标题）'}
                </div>
                <div className="draft-meta">
                  {row.article.author && <span>{row.article.author}</span>}
                  <span>{formatTime(row.updateTime)}</span>
                  {row.count > 1 && <span>合集 {row.count} 篇</span>}
                </div>
                {row.article.digest && <div className="draft-digest">{row.article.digest}</div>}
              </div>
              <div className="draft-actions">
                <button
                  type="button"
                  className={`btn ${openingRow === `${row.mediaId}:${row.index}` ? 'busy' : ''}`}
                  disabled={busy}
                  aria-busy={openingRow === `${row.mediaId}:${row.index}`}
                  onClick={() => void openBody(row)}
                >
                  {openingRow === `${row.mediaId}:${row.index}` && <Spinner size={13} />}
                  看正文
                </button>
                {row.article.url && (
                  <button
                    type="button"
                    className="btn icon"
                    title="在浏览器里打开预览链接"
                    aria-label="在浏览器里打开"
                    onClick={() => void openExternal(row.article.url)}
                  >
                    <ArrowSquareOut size={16} weight="regular" />
                  </button>
                )}
                <button type="button" className="btn primary" onClick={() => pick(row)} title="用当前正文覆盖这一篇">
                  <PencilSimple size={14} weight="bold" />
                  更新
                </button>
              </div>
            </div>
          ))}
          {!rows.length && !busy && !error && (
            <EmptyState
              icon={Tray}
              title="草稿箱是空的"
              hint="从工具栏推一篇上去，这里就会列出它。"
            />
          )}
        </div>
      )}
    </Modal>
  );
}
