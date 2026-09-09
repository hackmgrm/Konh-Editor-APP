import { useState } from 'react';
import { confirmDestructive } from '../confirm';
import { needsPublishReview } from '../publishJournal';
import { publishJournal, usePublishAttempts } from '../store/publishJournal';

const LABELS = { preparing: '准备未完成', submitting: '提交结果待核对', completed: '推送成功', failed: '失败，可重试', unknown: '提交结果待核对', resolved: '已人工核对' };

export default function PublishHistory({ articleKey, accountId, busy = false, onOpenDraftBox }: {
  articleKey: string;
  accountId?: string;
  busy?: boolean;
  onOpenDraftBox?: () => void;
}) {
  const attempts = usePublishAttempts().filter(item => item.snapshot.articleKey === articleKey && (!accountId || item.snapshot.accountId === accountId));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  if (!attempts.length) return null;
  return <section className="form-section publish-attempts" aria-label="推送记录与快照">
    <div className="form-section-label">推送记录与快照</div>
    {attempts.slice(0, 10).map(attempt => <details key={attempt.id} open={needsPublishReview(attempt) || undefined}>
      <summary>{LABELS[attempt.state]} · {attempt.snapshot.title} · {new Date(attempt.createdAt).toLocaleString()}</summary>
      <p className="form-hint">公众号：{attempt.snapshot.accountId} · {attempt.snapshot.target ? '更新已有草稿' : '新建草稿'}</p>
      <p>{attempt.message}{attempt.receipt ? ` · 草稿编号：${attempt.receipt.mediaId}` : ''}</p>
      {needsPublishReview(attempt) && <div className="publish-review-actions">
        {onOpenDraftBox && <button type="button" className="btn" disabled={busy || saving} onClick={onOpenDraftBox}>查看草稿箱</button>}
        <button type="button" className="btn" disabled={busy || saving} onClick={async () => {
          setSaving(true);
          try {
            if (!await confirmDestructive('请先到对应公众号草稿箱核对。若草稿已经创建，请选择“更新已有草稿”；只有确认未创建时才重新新建。确认已完成核对并解除拦截？', '已核对')) return;
            await publishJournal.resolve(attempt.id);
            setError('');
          } catch (e) { setError(e instanceof Error ? e.message : '核对结果保存失败'); }
          finally { setSaving(false); }
        }}>已核对，解除拦截</button>
      </div>}
      <details><summary>查看本次提交的原文与摘要</summary>
        <p>作者：{attempt.snapshot.author || '未填写'} · 摘要：{attempt.snapshot.digest || '自动提取'}</p>
        <pre className="publish-snapshot">{attempt.snapshot.markdown}</pre>
      </details>
    </details>)}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
