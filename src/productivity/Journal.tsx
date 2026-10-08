import { useState } from 'react';
import { Plus, Trash, X } from '@phosphor-icons/react';
import MarkdownIt from 'markdown-it';
import {
  dailySummary,
  dayKey,
  uid,
  type Journal as JournalRecord,
  type ProductivityData,
} from './model';
import { mutateProductivity } from './store';
import { confirmDestructive } from '../confirm';
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
const moods = ['很低落', '有点累', '还不错', '很开心', '特别棒'];
export default function Journal({ data }: { data: ProductivityData }) {
  const [draft, setDraft] = useState<JournalRecord | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState(false);
  const entries = data.journals
    .filter(
      (j) =>
        !j.deletedAt &&
        `${j.title}\n${j.body}`.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt - a.updatedAt);
  const dates = [...new Set(entries.map((j) => j.date))];
  const patch = (value: Partial<JournalRecord>) =>
    setDraft((d) => d && { ...d, ...value });
  return (
    <div className="p-task-layout">
      <section className="p-main-section">
        <header className="p-page-heading">
          <div>
            <div className="p-eyebrow">把日子，写成自己的样子</div>
            <h1>日记</h1>
          </div>
          <button
            className="p-primary"
            onClick={() => {
              setError('');
              setDraft({
                id: uid(),
                title: '',
                body: '',
                date: dayKey(),
                mood: 3,
                updatedAt: 0,
              });
            }}
          >
            <Plus size={18} />
            写一篇日记
          </button>
        </header>
        <input
          type="search"
          aria-label="搜索日记"
          placeholder="搜索日记…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {dates.map((date) => (
          <section key={date}>
            <h3 className="p-group-title">{date}</h3>
            {entries
              .filter((j) => j.date === date)
              .map((j) => (
                <button
                  className="p-journal-card"
                  key={j.id}
                  onClick={() => {
                    setDraft(structuredClone(j));
                    setError('');
                  }}
                >
                  <div>
                    <h2>{j.title || '无题'}</h2>
                    <span className="p-muted">
                      {['◔', '◑', '◕', '☀', '✦'][j.mood - 1]}{' '}
                      {moods[j.mood - 1]}
                    </span>
                  </div>
                  <p>{j.body.slice(0, 200)}</p>
                </button>
              ))}
          </section>
        ))}
        {!entries.length && (
          <div className="p-empty">
            <h2>今天有什么值得记住？</h2>
            <p>一段想法、一个小进展，或者只是此刻的心情。</p>
          </div>
        )}
      </section>
      {draft && (
        <aside className="p-detail p-journal-editor">
          <header>
            <h2>{draft.updatedAt ? '编辑日记' : '新日记'}</h2>
            <button
              className="p-icon"
              aria-label="关闭日记"
              onClick={() => setDraft(null)}
            >
              <X size={20} />
            </button>
          </header>
          <label>
            日期
            <input
              type="date"
              required
              value={draft.date}
              onChange={(e) => patch({ date: e.target.value })}
            />
          </label>
          <label>
            标题（可选）
            <input
              value={draft.title}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder="给今天起个名字"
            />
          </label>
          <label>
            心情
            <select
              value={draft.mood}
              onChange={(e) => patch({ mood: Number(e.target.value) })}
            >
              {moods.map((m, i) => (
                <option key={m} value={i + 1}>
                  {i + 1} · {m}
                </option>
              ))}
            </select>
          </label>
          <div className="p-field-row">
            <button
              onClick={() =>
                patch({
                  body: `${draft.body}${draft.body ? '\n\n' : ''}${dailySummary(data, draft.date)}`,
                })
              }
            >
              插入当天摘要
            </button>
            <button
              aria-pressed={preview}
              onClick={() => setPreview((p) => !p)}
            >
              {preview ? '继续编辑' : '预览 Markdown'}
            </button>
          </div>
          {preview ? (
            <div
              className="p-markdown"
              dangerouslySetInnerHTML={{ __html: markdown.render(draft.body) }}
            />
          ) : (
            <textarea
              className="p-journal-body"
              aria-label="日记正文"
              value={draft.body}
              onChange={(e) => patch({ body: e.target.value })}
              placeholder="支持 Markdown。今天过得怎么样？"
            />
          )}
          {error && (
            <p className="p-error" role="alert">
              {error}
            </p>
          )}
          <footer>
            <button
              className="p-primary"
              onClick={async () => {
                if (!draft.body.trim() || !draft.date) {
                  setError('请填写日期和日记正文');
                  return;
                }
                try {
                  await mutateProductivity((d) => {
                    const index = d.journals.findIndex(
                      (j) => j.id === draft.id,
                    );
                    if (
                      index >= 0 &&
                      d.journals[index].updatedAt !== draft.updatedAt
                    )
                      throw new Error('日记已经被修改，请重新打开');
                    const row = { ...draft, updatedAt: Date.now() };
                    if (index >= 0) d.journals[index] = row;
                    else d.journals.push(row);
                  });
                  setDraft(null);
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              保存日记
            </button>
            {draft.updatedAt > 0 && (
              <button
                className="p-icon"
                aria-label="删除日记"
                onClick={async () => {
                  if (await confirmDestructive('删除这篇日记？')) {
                    try {
                      await mutateProductivity((d) => {
                        const row = d.journals.find((j) => j.id === draft.id)!;
                        row.deletedAt = row.updatedAt = Date.now();
                      });
                      setDraft(null);
                    } catch (e) {
                      setError(String(e));
                    }
                  }
                }}
              >
                <Trash size={18} />
              </button>
            )}
          </footer>
        </aside>
      )}
    </div>
  );
}
