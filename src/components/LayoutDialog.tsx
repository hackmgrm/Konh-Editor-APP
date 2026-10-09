import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { X } from '@phosphor-icons/react';
import { artifactBody, artifactDocument, deleteArtifact, freezeArticleHtml, packageArtifact, readArtifact, saveArtifact, type ArticleArtifact } from '../artifacts';
import { contentHash } from '../publishJournal';
import { acceptLayout, beginLayout, confirmLayout } from '../layoutResults';
import { getLayoutState, updateLayouts, useLayoutState } from '../store/layoutResults';

interface Props {
  open: boolean; articleKey: string; markdown: string; revision: object; themeId: string;
  renderMarkdown: (markdown: string) => Promise<string>;
  onClose: () => void; onApply: (markdown: string) => void;
}
export default function LayoutDialog({ open, articleKey, markdown, revision, themeId, renderMarkdown, onClose, onApply }: Props) {
  const state = useLayoutState();
  const [requirement, setRequirement] = useState('保留原文，梳理标题层级和段落，突出重点。');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<ArticleArtifact | null>(null);
  const [sourceHash, setSourceHash] = useState('');
  const sequence = useRef(0);
  const selecting = useRef(0);
  const live = useRef({ articleKey, markdown, revision, open });
  live.current = { articleKey, markdown, revision, open };
  useEffect(() => {
    sequence.current++; selecting.current++; setBusy(false); setSelected(null); setError('');
    return () => { sequence.current++; selecting.current++; };
  }, [open, articleKey]);
  useEffect(() => { let cancelled = false; void contentHash(markdown).then(hash => { if (!cancelled) setSourceHash(hash); }); return () => { cancelled = true; }; }, [markdown]);
  if (!open) return null;
  const results = state.candidates[articleKey] ?? [];
  const result = results.find(item => item.id === selected?.id);
  const adopted = !!selected && state.confirmed[articleKey] === selected.id;
  const stale = !!result && result.sourceHash !== sourceHash;
  const select = async (id: string) => {
    const turn = ++selecting.current;
    try {
      const artifact = await readArtifact(id);
      if (turn === selecting.current && live.current.articleKey === articleKey) { setSelected(artifact); setError(''); }
    } catch (e) { if (turn === selecting.current) setError(String(e)); }
  };
  const generate = async () => {
    const turn = ++sequence.current;
    const requestId = crypto.randomUUID();
    const current = () => sequence.current === turn && live.current.open && live.current.articleKey === articleKey && live.current.markdown === markdown && live.current.revision === revision;
    setBusy(true); setError('');
    let savedId: string | undefined;
    try {
      await updateLayouts(value => beginLayout(value, articleKey, requestId));
      if (!current()) return;
      const originalHash = await contentHash(markdown);
      const [candidate, originalHtml] = await Promise.all([
        invoke<string>('writing_layout', { article: markdown, requirement, themeId }),
        renderMarkdown(markdown).then(freezeArticleHtml),
      ]);
      if (!current()) { setError('原文或排版已变化，本次结果未采用，请重新生成'); return; }
      const html = await freezeArticleHtml(await renderMarkdown(candidate));
      if (!current()) return;
      const artifact = packageArtifact({ id: crypto.randomUUID(), kind: 'layout', articleKey, title: 'AI 排版候选', createdAt: Date.now(), markdown: candidate, originalMarkdown: markdown, originalHtml, html, submittedHtml: '' });
      await saveArtifact(artifact); savedId = artifact.id;
      if (!current()) return;
      const result = { id: artifact.id, requestId, sourceHash: originalHash, resultHash: await contentHash(candidate), createdAt: artifact.createdAt };
      await updateLayouts(value => current() ? acceptLayout(value, articleKey, result, originalHash) : value);
      if (getLayoutState().candidates[articleKey]?.some(item => item.id === artifact.id)) {
        savedId = undefined;
        if (current()) setSelected(artifact);
      }
    } catch (e) { if (sequence.current === turn) setError(String(e)); }
    finally {
      if (savedId) await deleteArtifact(savedId).catch(() => {});
      if (sequence.current === turn) setBusy(false);
    }
  };
  const apply = async () => {
    if (!selected || !result) return;
    const currentMarkdown = markdown;
    setBusy(true); setError('');
    try {
      const renderedNow = await freezeArticleHtml(await renderMarkdown(currentMarkdown));
      if (await contentHash(renderedNow) !== await contentHash(artifactBody(selected, true))) throw new Error('排版设置或图片已变化，请重新生成候选后再采用');
      if (await contentHash(selected.markdown) !== result.resultHash) throw new Error('候选文件已变化，不能采用');
      const actualHash = await contentHash(currentMarkdown);
      await updateLayouts(value => {
        if (live.current.articleKey !== articleKey || live.current.markdown !== currentMarkdown || live.current.revision !== revision || !live.current.open) throw new Error('原文已变化，请重新确认');
        return confirmLayout(value, articleKey, selected.id, actualHash);
      });
      if (live.current.articleKey !== articleKey || live.current.markdown !== currentMarkdown || live.current.revision !== revision || !live.current.open) throw new Error('原文已变化，本次没有替换正文');
      onApply(selected.markdown);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal layout-dialog" role="dialog" aria-modal="true" aria-label="AI 排版候选">
      <header className="modal-head"><h2>AI 排版候选</h2><button className="modal-close" onClick={onClose} aria-label="关闭"><X size={16} /></button></header>
      <div className="modal-body">
        <p className="form-hint">使用已配置的 API Agent 整理标题、段落和重点。生成结果独立保存，采用前请核对文字和事实。</p>
        <label className="field"><span>排版要求</span><input value={requirement} maxLength={1000} disabled={busy} onChange={e => setRequirement(e.target.value)} /></label>
        <div className="layout-actions"><button className="btn" disabled={busy || !markdown.trim()} onClick={() => void generate()}>{busy ? '处理中…' : '生成新候选'}</button>
          <select aria-label="历史排版候选" value={selected?.id ?? ''} disabled={busy} onChange={e => void select(e.target.value)}><option value="" disabled>查看历史候选</option>{results.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()}{state.confirmed[articleKey] === item.id ? ' · 已采用' : ''}</option>)}</select></div>
        {selected && <>
          <div className="layout-comparison"><div><h3>生成时的原稿</h3><iframe sandbox="" title="原稿排版" srcDoc={artifactDocument(selected, true)} /></div><div><h3>{adopted ? '已采用排版' : '候选排版'}</h3><iframe sandbox="" title="候选排版预览" srcDoc={artifactDocument(selected)} /></div></div>
          <details><summary>核对 Markdown 文字差异</summary><div className="layout-comparison"><pre>{selected.originalMarkdown}</pre><pre>{selected.markdown}</pre></div></details>
          {stale && !adopted && <p className="form-caution">原文已变化，此候选只能查看，请重新生成后再采用。</p>}
        </>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer className="modal-foot"><button className="btn" onClick={onClose}>关闭</button><button className="btn primary" disabled={busy || !selected || stale || adopted} onClick={() => void apply()}>{adopted ? '已采用' : '采用此排版'}</button></footer>
    </section>
  </div>;
}
