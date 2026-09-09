import ArticleArtifacts from './ArticleArtifacts';
import PublishHistory from './PublishHistory';
import { useEffect, useMemo, useState } from 'react';
import { ArrowCounterClockwise, ClockCounterClockwise, X } from '@phosphor-icons/react';
import { savePublishedLink, type ArticleVersion, type ContentState, type ContentStatus } from '../store/contentState';
import { getWechatAccounts, useWechatConfig } from '../store/wechatConfig';

const STATUSES: Array<{ id: ContentStatus; name: string }> = [
  { id: 'idea', name: '构思' },
  { id: 'writing', name: '写作中' },
  { id: 'review', name: '待审核' },
  { id: 'scheduled', name: '待发布' },
  { id: 'published', name: '已发布' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  articleKey: string;
  content: string;
  state: ContentState;
  onState: (state: ContentState) => void;
  onRestore: (content: string) => void;
}

function lineDiff(before: string, after: string) {
  const left = before.split('\n');
  const right = after.split('\n');
  const rows: Array<{ old: string; next: string; changed: boolean }> = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    rows.push({ old: left[i] ?? '', next: right[i] ?? '', changed: left[i] !== right[i] });
  }
  return rows;
}

export default function ArticleCenterDialog({ open, onClose, articleKey, content, state, onState, onRestore }: Props) {
  const cfg = useWechatConfig();
  const accounts = getWechatAccounts().accounts.filter(account => account.appid);
  const [linkAccount, setLinkAccount] = useState(cfg.appid);
  const [articleUrl, setArticleUrl] = useState('');
  const [linkError, setLinkError] = useState('');
  useEffect(() => { setLinkAccount(cfg.appid); setLinkError(''); }, [open, articleKey, cfg.appid]);
  useEffect(() => { setArticleUrl(state.publishedLinks[articleKey]?.find(item => item.accountId === linkAccount)?.url ?? ''); setLinkError(''); }, [articleKey, linkAccount, state.publishedLinks, open]);
  const versions = state.versions[articleKey] ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = versions.find((item) => item.id === selectedId) ?? versions[0] ?? null;
  const rows = useMemo(() => (selected ? lineDiff(selected.content, content) : []), [selected, content]);
  const records = state.publishRecords.filter((item) => item.articleKey === articleKey);
  const bindings = Object.values(state.bindings[articleKey] ?? {});
  if (!open) return null;

  const setStatus = (status: ContentStatus) => onState({ ...state, statuses: { ...state.statuses, [articleKey]: status } });
  const restore = (version: ArticleVersion) => {
    if (!window.confirm(`恢复到 ${new Date(version.createdAt).toLocaleString()} 的版本？当前内容会先保留为版本。`)) return;
    onRestore(version.content);
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal article-center" role="dialog" aria-modal="true" aria-label="文章管理">
        <header className="modal-head">
          <div><h2>文章管理</h2><p>状态、版本和公众号发布关联</p></div>
          <button className="ghost-btn" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </header>

        <div className="article-status-row">
          <strong>内容状态</strong>
          <div className="status-pills">
            {STATUSES.map((item) => <button key={item.id} className={state.statuses[articleKey] === item.id ? 'on' : ''} onClick={() => setStatus(item.id)}>{item.name}</button>)}
          </div>
        </div>

        <div className="article-center-grid">
          <aside className="version-list scroll-thin">
            <div className="section-title"><ClockCounterClockwise size={16} />版本历史</div>
            {versions.length === 0 ? <p className="empty-note">编辑后会自动保存版本快照。</p> : versions.map((version) => (
              <button key={version.id} className={selected?.id === version.id ? 'active' : ''} onClick={() => setSelectedId(version.id)}>
                <strong>{version.label}</strong><span>{new Date(version.createdAt).toLocaleString()}</span>
              </button>
            ))}
          </aside>
          <div className="version-detail">
            {selected ? <>
              <div className="section-title"><span>与当前版本对比</span><button className="btn" onClick={() => restore(selected)}><ArrowCounterClockwise size={14} />恢复此版本</button></div>
              <div className="diff-head"><span>历史版本</span><span>当前版本</span></div>
              <div className="diff-body scroll-thin">{rows.map((row, index) => <div key={index} className={row.changed ? 'diff-row changed' : 'diff-row'}><pre>{row.old || ' '}</pre><pre>{row.next || ' '}</pre></div>)}</div>
            </> : <p className="empty-note">暂无历史版本。</p>}
          </div>
        </div>

        <div className="publish-history">
          <div className="section-title">公众号关联</div>
          {bindings.length ? bindings.map(binding => <p key={binding.accountId}>{accounts.find(account => account.appid === binding.accountId)?.name ?? binding.accountId} · <strong>{binding.title}</strong> · <code>{binding.mediaId}</code></p>) : <p className="empty-note">尚未关联公众号草稿，首次发布后会自动建立关联。</p>}
          <div className="published-link-form">
            <label className="field"><span>正式发布账户</span><select value={linkAccount} onChange={event => setLinkAccount(event.target.value)}><option value="">选择公众号</option>{accounts.map(account => <option key={account.id} value={account.appid}>{account.name} · {account.appid}</option>)}</select></label>
            <label className="field"><span>正式文章链接</span><input type="url" value={articleUrl} onChange={event => setArticleUrl(event.target.value)} placeholder="https://mp.weixin.qq.com/s/…" /></label>
            <button className="btn" disabled={!articleUrl.trim() || !linkAccount} onClick={() => { try { onState(savePublishedLink(state, articleKey, linkAccount, articleUrl)); setLinkError(''); } catch { setLinkError('请输入有效的公众号文章 HTTPS 链接（mp.weixin.qq.com/s/…）'); } }}>保存链接并标记已发布</button>
            {linkError && <p className="form-error" role="alert">{linkError}</p>}
            {(state.publishedLinks[articleKey] ?? []).map(item => <div className="publish-record" key={item.accountId}><span>{accounts.find(account => account.appid === item.accountId)?.name ?? item.accountId}</span><a href={item.url}>打开正式文章</a><button className="btn" onClick={() => onState({ ...state, publishedLinks: { ...state.publishedLinks, [articleKey]: state.publishedLinks[articleKey].filter(link => link.accountId !== item.accountId) } })}>移除关联</button></div>)}
          </div>
          <PublishHistory articleKey={articleKey} />
          <ArticleArtifacts key={articleKey} articleKey={articleKey} />
          {records.map((record) => <div className="publish-record" key={record.id}><span>{record.action === 'created' ? '新建草稿' : '更新草稿'}</span><strong>{record.title}<small> · {accounts.find(account => account.appid === record.accountId)?.name ?? record.accountId}</small></strong><time>{new Date(record.createdAt).toLocaleString()}</time></div>)}
        </div>
      </section>
    </div>
  );
}
