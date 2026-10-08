import Modal from './Modal';
import Spinner from './Spinner';
import { useEffect, useRef, useState } from 'react';
import { ArrowCounterClockwise, CheckCircle, GearSix, PaperPlaneTilt, Stack } from '@phosphor-icons/react';
import { prepareImage } from '../images';
import { publishToDraft, type DraftTarget } from '../publish';
import { isConfigured, WechatError } from '../wechat';
import { contentHash, type PublishSnapshot } from '../publishJournal';
import { publishJournal } from '../store/publishJournal';
import { fetchImageAsDataUrl } from '../remoteImages';
import { freezeArticleHtml, packageArtifact, saveArtifact } from '../artifacts';
import PublishHistory from './PublishHistory';
import { getWechatConfig, patchWechatConfig, useWechatConfig } from '../store/wechatConfig';
import { checkArticle, checkPublishFields, hasBlockingIssues, type ArticleCheckInput } from '../preflight';
import PreflightIssues from './PreflightIssues';
import CoverWorkbench from './CoverWorkbench';
import WritingTools from './WritingTools';

interface Props {
  articleKey: string;
  contentRevision: object;
  open: boolean;
  onClose: () => void;
  /** Default article title (first H1 in the body, falling back to the draft name) */
  defaultTitle: string;
  /** Current source-level checks, shared with rich-text copy. */
  articleCheckInput: ArticleCheckInput;
  /** The rendered body can supply the default cover from its first image. */
  articleHasImage: boolean;
  /** Render the body HTML now — the preview runs off a deferred value, and a
   *  push has to re-render from the current body */
  buildHtml: () => Promise<string>;
  onFlash: (msg: string) => void;
  /** Credentials live in the settings dialog now, so this one has to be able
   *  to send you there when they are missing */
  onOpenSettings: () => void;
  /**
   * Set when this push should overwrite a draft picked in the drafts box
   * instead of creating a new one. Null is the ordinary "push a new draft" case.
   */
  target: DraftTarget | null;
  /** Digest as it stands on the target draft, so an update does not blank it */
  targetDigest: string;
  /** Go pick a draft to overwrite */
  onOpenDraftBox: () => void;
  /** Drop the target and go back to creating a new draft */
  onClearTarget: () => void;
  onPublished?: (result: { articleKey: string; mediaId: string; updated: boolean; title: string; accountId: string; articleIndex: number }) => void;
}

/**
 * Push straight to the WeChat drafts box.
 *
 * The push uploads every image in the body to WeChat first and swaps in the
 * mmbiz address. That step cannot be skipped: the API does not accept data
 * URIs, and an image pasted directly gets compressed by WeChat while one
 * uploaded through the API does not.
 *
 * Credentials are not here: they are configured once, in the settings dialog,
 * and left alone. What stays is what you decide per push — the title, the
 * summary, the cover — plus the publishing options, which are remembered as
 * defaults but are still worth a look each time.
 */
export default function PublishDialog({
  articleKey,
  contentRevision,
  open,
  onClose,
  defaultTitle,
  articleCheckInput,
  articleHasImage,
  buildHtml,
  onFlash,
  onOpenSettings,
  target,
  targetDigest,
  onOpenDraftBox,
  onClearTarget,
  onPublished,
}: Props) {
  const cfg = useWechatConfig();
  const [title, setTitle] = useState(defaultTitle);
  const [digest, setDigest] = useState('');
  const [cover, setCover] = useState<{ dataUrl: string; filename: string } | null>(null);
  const [generatedCover, setGeneratedCover] = useState<{ dataUrl: string; filename: string } | null>(null);
  const [coverWorkbenchOpen, setCoverWorkbenchOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generatingTitle, setGeneratingTitle] = useState(false);
  const [generatingCover, setGeneratingCover] = useState(false);
  const [progress, setProgress] = useState('');
  const [probe, setProbe] = useState<{ kind: 'ok' | 'warn' | 'fail'; message: string } | null>(null);
  const uploadRatio = (() => {
    const match = /(\d+)\/(\d+)/.exec(progress);
    if (!match) return null;
    const total = Number(match[2]);
    return total > 0 ? Math.min(1, Number(match[1]) / total) : null;
  })();
  const titleRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef<HTMLInputElement>(null);
  const publishing = useRef(false);
  const currentContext = useRef({ articleKey, contentRevision });
  currentContext.current = { articleKey, contentRevision };

  /*
   * Follow the open draft's title each time the dialog opens.
   *
   * Aiming at an existing draft changes what the fields should say: the title
   * and summary become the ones already up there, so pressing 更新 without
   * touching anything leaves them as they were rather than overwriting them
   * with whatever the local file happens to be called.
   */
  useEffect(() => {
    if (open) {
      setTitle(target?.title || defaultTitle);
      setDigest(targetDigest);
      // A cover chosen for the previous article must never silently follow the
      // next one into its preflight result or its published draft.
      setCover(null);
      setGeneratedCover(null);
      setCoverWorkbenchOpen(false);
      setProbe(null);
      setProgress('');
    }
  }, [open, defaultTitle, target, targetDigest]);

  useEffect(() => {
    if (!coverWorkbenchOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setCoverWorkbenchOpen(false); setGeneratedCover(null); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [coverWorkbenchOpen]);


  const configured = isConfigured(cfg);
  const preflightIssues = [
    ...checkArticle(articleCheckInput),
    ...checkPublishFields({
      title,
      digest,
      author: cfg.author,
      hasCover: !!cover,
      keepsExistingCover: !!target,
      articleHasImage,
    }),
  ];
  const publishBlocked = hasBlockingIssues(preflightIssues);

  const pickCover = async (file: File) => {
    try {
      setCover({ dataUrl: await prepareImage(file), filename: file.name });
    } catch {
      setProbe({ kind: 'fail', message: '封面图读取失败' });
    }
  };

  const handlePublish = async () => {
    if (publishing.current || generatingTitle || generatingCover) return;
    if (publishBlocked) {
      setProbe({ kind: 'fail', message: '请先处理发布检查中的必改问题' });
      return;
    }
    if (!configured) {
      setProbe({ kind: 'fail', message: '还没填公众号凭据 —— 去「设置」里填 AppID 与 AppSecret' });
      return;
    }
    publishing.current = true;
    setBusy(true);
    setProbe(null);
    const account = { ...cfg };
    const frozenTarget = target ? { ...target } : undefined;
    const frozenCover = cover ? { ...cover } : undefined;
    const checkCurrent = () => {
      if (currentContext.current.articleKey !== articleKey || currentContext.current.contentRevision !== contentRevision) throw new Error('文章或排版已变化，请重新检查后推送');
      if (getWechatConfig().appid !== account.appid || (frozenTarget && frozenTarget.accountId !== account.appid)) throw new Error('公众号已变化，请重新选择目标草稿');
    };
    try {
      checkCurrent();
      setProgress('正在固定正文与图片…');
      const rendered = await buildHtml();
      const html = await freezeArticleHtml(rendered);
      let snapshotCover = frozenCover?.dataUrl;
      if (!snapshotCover && frozenTarget && !frozenTarget.thumbUrl) throw new Error('原草稿没有可读取的封面地址，请选择一张封面后重试');
      if (!snapshotCover && frozenTarget?.thumbUrl) {
        snapshotCover = await fetchImageAsDataUrl(frozenTarget.thumbUrl) ?? undefined;
        if (!snapshotCover) throw new Error('原草稿封面无法保存，请检查网络后重试');
      }
      if (!snapshotCover && !frozenTarget) {
        snapshotCover = new DOMParser().parseFromString(html, 'text/html').querySelector('img:not([data-no-cover="true"])')?.getAttribute('src') ?? undefined;
      }
      checkCurrent();
      const snapshot: PublishSnapshot = {
        articleKey, accountId: account.appid, title, markdown: articleCheckInput.markdown,
        htmlHash: await contentHash(html), coverHash: await contentHash(frozenCover?.dataUrl ?? ''), digest,
        author: account.author, sourceUrl: account.sourceUrl, openComment: account.openComment,
        target: frozenTarget ? { mediaId: frozenTarget.mediaId, index: frozenTarget.index, thumbMediaId: frozenTarget.thumbMediaId } : null,
      };
      const { mediaId, updated, uploaded, smallestEdge, roundTrip } = await publishJournal.run(snapshot, beforeSubmit => publishToDraft(account, {
        title,
        html,
        digest,
        cover: frozenCover,
        onProgress: setProgress,
        target: frozenTarget,
        beforeSubmit: async article => {
          checkCurrent();
          const artifactId = crypto.randomUUID();
          const artifact = packageArtifact({ id: artifactId, kind: 'publish', articleKey, title, createdAt: Date.now(), markdown: snapshot.markdown, html: article.content, submittedHtml: article.content }, html, snapshotCover);
          await saveArtifact(artifact);
          checkCurrent();
          await beforeSubmit(artifactId);
        },
      }), error => error instanceof WechatError);
      setProgress('');
      console.info('草稿 media_id', mediaId);
      onPublished?.({ articleKey, mediaId, updated, title, accountId: account.appid, articleIndex: frozenTarget?.index ?? 0 });
      onFlash(
        `${updated ? '已更新草稿' : '已推送到草稿箱'}（换图 ${uploaded} 张${smallestEdge ? `，最小长边 ${smallestEdge}px` : ''}）`,
      );
      if (roundTrip) {
        const { sent, stored, rendered, url } = roundTrip;
        // Judge by the size the body actually uses (/640), falling back to /0
        const shown = rendered ?? stored;
        const shrunk = shown.w < sent.w || shown.h < sent.h;
        // This verdict is the only evidence that separates "we compressed it"
        // from "WeChat compressed it", so it stays in the dialog for the user.
        // The address goes with it: an mmbiz URL carries a size segment, and
        // which one the body references decides how large readers see the image.

        setProbe({
          kind: shrunk ? 'warn' : 'ok',
          message:
            `传出 ${sent.w}×${sent.h} ${Math.round(sent.bytes / 1024)}KB\n` +
            `原图档 /0：${stored.w}×${stored.h} ${Math.round(stored.bytes / 1024)}KB\n` +
            (rendered
              ? `正文实际用的 /640：${rendered.w}×${rendered.h} ${Math.round(rendered.bytes / 1024)}KB\n`
              : '') +
            (shrunk
              ? '\n读者看到的是被规格化后的那一档 —— 这是微信对接口上传图的固定行为，改不了。\n'
              : '\n各档尺寸一致，没有被规格化。\n') +
            `\n正文引用的地址：\n${url}`,
        });
        return; // Leave the dialog open so the user can read the verdict
      }
      onClose();
    } catch (err) {
      setProgress('');
      // publishToDraft attaches the body-side wording (it has the real
      // post-swap body to work from)
      let message = err instanceof Error ? err.message : '推送失败';
      setProbe({ kind: 'fail', message });
    } finally {
      publishing.current = false;
      setBusy(false);
    }
  };

  /**
   * Automatic 45166 bisection: minimal body → full body → drop suspicious
   * constructs one at a time.
   * This leaves a few test drafts in the drafts box, and reminds the user to
   * clean them up when it finishes.
   */
  return (
    <>
    <Modal open={open && !coverWorkbenchOpen} onClose={onClose} busy={busy} initialFocus={titleRef} onSubmit={() => void handlePublish()} title={target ? '更新草稿' : '推送到草稿箱'} foot={<>

          {probe && (
            <span className={probe.kind === 'ok' ? 'form-ok' : probe.kind === 'warn' ? 'form-caution' : 'form-error'}>
              {probe.kind === 'ok' && <CheckCircle size={13} weight="fill" />}
              {probe.message}
            </span>
          )}
          {busy && progress && <span className="publish-progress"><span className="update-bar"><span className={`update-bar-fill ${uploadRatio === null ? 'indeterminate' : ''}`} style={uploadRatio === null ? undefined : { width: `${Math.round(uploadRatio * 100)}%` }} /></span><span className="form-progress">{progress}</span></span>}
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className={`btn primary ${busy ? 'busy' : ''}`} aria-busy={busy} type="submit" disabled={busy || generatingTitle || generatingCover || publishBlocked}>
            {busy ? <Spinner /> : <PaperPlaneTilt size={15} weight="bold" />}
            {busy ? (target ? '更新中…' : '推送中…') : target ? '更新这篇草稿' : '推到草稿箱'}
          </button>

    </>}>

          <fieldset className="publish-fields" disabled={busy}>
          <section className="form-section">
            <div className="form-section-label">推到哪里</div>
            {/* Which draft this push lands in. A new one by default; pointed at
                an existing one, it says so plainly and offers the way back —
                overwriting the wrong article is not something to discover
                afterwards. */}
            <div className="target-line">
              {target ? (
                <>
                  <span className="target-badge">覆盖</span>
                  <span className="target-title" title={target.title}>
                    {target.title || '（无标题）'}
                  </span>
                  <button type="button" className="btn" onClick={onClearTarget} disabled={busy}>
                    <ArrowCounterClockwise size={14} weight="bold" />
                    改为新建
                  </button>
                </>
              ) : (
                <>
                  <span className="form-hint">在草稿箱里新建一篇</span>
                  <button type="button" className="btn target-pick" onClick={onOpenDraftBox} disabled={busy}>
                    <Stack size={14} weight="bold" />
                    改为更新已有草稿
                  </button>
                </>
              )}
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-label">这一篇</div>
            <label className="field">
              <span>标题</span>
              <input ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={32} placeholder="必填，最多 32 字" />
            </label>
            <WritingTools mode="titles" onBusyChange={setGeneratingTitle} article={articleCheckInput.markdown} disabled={busy} onTitle={setTitle} />
            <label className="field">
              <span>摘要</span>
              <input value={digest} onChange={(e) => setDigest(e.target.value)} maxLength={120} placeholder="留空则取正文开头" />
            </label>
            <WritingTools mode="cover" onBusyChange={setGeneratingCover} article={articleCheckInput.markdown} disabled={busy} onCover={value => { setGeneratedCover(value); setCoverWorkbenchOpen(true); }} />
            <div className="field">
              <span>封面</span>
              <div className="cover-picker">
                <input
                  ref={coverRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void pickCover(file);
                    e.target.value = '';
                  }}
                />
                {cover && <img className="cover-thumb" src={cover.dataUrl} alt="封面预览" />}
                <button type="button" className="btn" onClick={() => coverRef.current?.click()}>
                  {cover ? '换一张' : '选择封面'}
                </button>
                {cover ? (
                  <><button type="button" className="btn" onClick={() => setCoverWorkbenchOpen(true)}>封面工作台</button><button type="button" className="link-btn" onClick={() => setCover(null)}>{target ? '改用草稿原封面' : '改用正文第一张图'}</button></>
                ) : (
                  <span className="form-hint">{target ? '不选则保留草稿原封面' : '不选则用正文第一张图'}</span>
                )}
              </div>
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-label">推给哪个号</div>
            {/* Just enough to catch "wrong account" before the push, and one
                way through to where it is changed — the credentials themselves
                are in the settings dialog */}
            <div className="account-line">
              <span className={`account-dot ${configured ? 'ok' : 'off'}`} aria-hidden="true" />
              {configured ? (
                <>
                  <code className="account-appid">{cfg.appid}</code>
                  <span className="form-hint">凭据已配置</span>
                </>
              ) : (
                <span className="form-hint">还没填凭据，推不上去</span>
              )}
              <button type="button" className="btn account-settings" onClick={onOpenSettings}>
                <GearSix size={14} weight="bold" />
                {configured ? '改凭据' : '去填'}
              </button>
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-label">发布设置</div>
            <label className="field">
              <span>作者</span>
              <input
                value={cfg.author}
                onChange={(e) => patchWechatConfig({ author: e.target.value })}
                maxLength={16}
                placeholder="可空，最多 16 字"
              />
            </label>
            <label className="field">
              <span>原文链接</span>
              <input
                value={cfg.sourceUrl}
                onChange={(e) => patchWechatConfig({ sourceUrl: e.target.value.trim() })}
                placeholder="可空，显示为「阅读原文」"
              />
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={cfg.openComment}
                onChange={(e) => patchWechatConfig({ openComment: e.target.checked })}
              />
              <span>打开留言</span>
            </label>
          </section>
          <section className="form-section">
            <div className="form-section-label">发布前检查</div>
            <PreflightIssues issues={preflightIssues} />
          </section>
          </fieldset>
          <PublishHistory articleKey={articleKey} accountId={cfg.appid} busy={busy} onOpenDraftBox={onOpenDraftBox} />

    </Modal>
        <CoverWorkbench open={coverWorkbenchOpen} source={generatedCover ?? cover} onClose={() => { setCoverWorkbenchOpen(false); setGeneratedCover(null); }} onApply={(next) => { setCover(next); setGeneratedCover(null); setCoverWorkbenchOpen(false); }} />
    </>
  );
}
