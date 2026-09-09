import { useEffect, useState } from 'react';
import { artifactDocument, deleteArtifact, listArtifacts, readArtifact, type ArticleArtifact, type ArtifactSummary } from '../artifacts';
import { confirmDestructive } from '../confirm';
import { safeFileName, saveBlob } from '../exchange';
import { needsPublishReview } from '../publishJournal';
import { getPublishAttempts } from '../store/publishJournal';
import { getLayoutState, updateLayouts } from '../store/layoutResults';

export default function ArticleArtifacts({ articleKey }: { articleKey: string }) {
  const [items, setItems] = useState<ArtifactSummary[]>([]);
  const [selected, setSelected] = useState<ArticleArtifact | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSelected(null); setError('');
    void listArtifacts(articleKey).then(value => { if (!cancelled) setItems(value); }).catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [articleKey]);
  const protectedId = (id: string) => getPublishAttempts().some(item => item.artifactId === id && needsPublishReview(item)) || Object.values(getLayoutState().confirmed).includes(id);
  const remove = async (item: ArtifactSummary) => {
    setBusy(true); setError('');
    try {
      if (protectedId(item.id)) throw new Error('待核对推送或当前采用的排版不能清理');
      if (!await confirmDestructive('只删除这份本机快照及其图片，原文章和微信草稿不受影响。删除后不能再离线查看或导出此版式。', '删除快照')) return;
      if (protectedId(item.id)) throw new Error('此快照正在使用，不能清理');
      await deleteArtifact(item.id);
      await updateLayouts(state => ({ ...state, candidates: { ...state.candidates, [articleKey]: (state.candidates[articleKey] ?? []).filter(value => value.id !== item.id) } }));
      setItems(value => value.filter(other => other.id !== item.id));
      if (selected?.id === item.id) setSelected(null);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <section className="article-artifacts">
    <div className="section-title">本机完整快照 · {(items.reduce((sum, item) => sum + item.bytes, 0) / 1024 / 1024).toFixed(1)} MB</div>
    <p className="form-hint">独立保存正文、排版和图片。手动按份清理；待核对推送和当前采用的排版保留。微信展示效果可能经过平台再次处理。</p>
    {items.map(item => <div className="artifact-row" key={item.id}><span>{item.kind === 'publish' ? '发布快照' : '排版候选'} · {new Date(item.createdAt).toLocaleString()} · {(item.bytes / 1024 / 1024).toFixed(1)} MB</span>
      <button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { setSelected(await readArtifact(item.id)); setError(''); } catch (e) { setError(String(e)); } finally { setBusy(false); } }}>查看</button>
      <button className="btn" disabled={busy || protectedId(item.id)} onClick={() => void remove(item)}>清理</button></div>)}
    {!items.length && <p className="empty-note">新生成的排版候选和新推送的完整快照会出现在这里。历史文字记录仍可在上方查看。</p>}
    {selected && <div>
      <div className="layout-actions"><button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { await saveBlob(`${safeFileName(selected.title)}-快照.html`, new Blob([artifactDocument(selected)], { type: 'text/html;charset=utf-8' })); setError(''); } catch (e) { setError(String(e)); } finally { setBusy(false); } }}>导出离线 HTML（含图片）</button><button className="btn" onClick={() => setSelected(null)}>收起预览</button></div>
      <iframe sandbox="" className="artifact-preview" title="完整快照预览" srcDoc={artifactDocument(selected)} />
      {selected.submittedHtml && <details><summary>查看本次发布的正文 HTML</summary><pre className="publish-snapshot">{selected.submittedHtml}</pre></details>}
    </div>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
