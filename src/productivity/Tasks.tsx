import { formatClock } from './model';
import { useMemo, useRef, useState } from 'react';
import {
  Check,
  Plus,
  PushPin,
  Play,
  Trash,
  X,
  DotsSixVertical,
  ArrowCounterClockwise,
} from '@phosphor-icons/react';
import {
  addDays,
  addQuickTask,
  clockText,
  completeTask,
  dateTime,
  dayKey,
  elapsed,
  estimateMinutes,
  parseQuickAdd,
  repeatNames,
  startTimer,
  uid,
  viewNames,
  visibleTasks,
  type ProductivityData,
  type Repeat,
  type Task,
  type View,
} from './model';
import { mutateProductivity } from './store';
import { confirmDestructive } from '../confirm';

export function QuickAdd({
  onAdded,
  compact = false,
}: {
  onAdded?: () => void;
  compact?: boolean;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseQuickAdd(text), [text]);
  return (
    <form
      className={`p-quick ${compact ? 'compact' : ''}`}
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || !text.trim()) return;
        setBusy(true);
        setError('');
        try {
          await mutateProductivity((d) => {
            addQuickTask(d, text);
          });
          setText('');
          onAdded?.();
        } catch (e) {
          setError(String(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="p-quick-input">
        <Plus size={20} />
        <input
          id="task-quick-add"
          aria-label="快速添加任务"
          placeholder="添加任务，例如：明天下午3点 预约牙医 #生活 p2"
          value={text}
          onChange={(e) => setText(e.target.value)}
          autoComplete="off"
        />
        <button className="p-primary" disabled={busy || !parsed.title}>
          添加任务 ↵
        </button>
      </div>
      {text && (
        <div className="p-chips" aria-live="polite">
          <span>{parsed.title || '请补充任务内容'}</span>
          {parsed.due && (
            <span>
              {parsed.due} {parsed.time}
            </span>
          )}
          {parsed.repeat !== 'none' && (
            <span>{repeatNames[parsed.repeat]}</span>
          )}
          {parsed.priority !== 4 && <span>P{parsed.priority}</span>}
          {parsed.labels.map((l) => (
            <span key={l}>#{l}</span>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="p-error">
          {error}
        </p>
      )}
    </form>
  );
}

function relativeDate(due: string, relative: boolean) {
  if (!relative) return due;
  const today = dayKey();
  if (due === today) return '今天';
  if (due === addDays(today, 1)) return '明天';
  const delta = Math.round(
    (new Date(`${due}T12:00:00`).getTime() -
      new Date(`${today}T12:00:00`).getTime()) /
      86400000,
  );
  return delta < 0 ? `逾期 ${-delta} 天` : `${delta} 天后`;
}
export function TaskList({
  data,
  view,
  onView,
}: {
  data: ProductivityData;
  view: View;
  onView: (v: View) => void;
}) {
  const [query, setQuery] = useState('');
  const [priority, setPriority] = useState(0);
  const [label, setLabel] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [celebration, setCelebration] = useState('');
  const dragged = useRef<string | null>(null);
  const tasks = visibleTasks(data, view, query, priority, label);
  const active = data.tasks.find((t) => t.id === selected && !t.deletedAt);
  const groups: [string, Task[]][] =
    view === 'upcoming'
      ? [...new Set(tasks.map((t) => t.due))].map((due) => [
          due,
          tasks.filter((t) => t.due === due),
        ])
      : [['', tasks]];
  const mutate = (fn: (d: ProductivityData) => void) => {
    void mutateProductivity(fn).catch(() => {});
  };
  async function finish(task: Task) {
    try {
      await mutateProductivity((d) => completeTask(d, task.id));
      if (!task.completedAt && data.settings.celebrate) {
        setCelebration(`完成了「${task.title}」`);
        window.setTimeout(() => setCelebration(''), 2400);
      }
    } catch {
      /* The store exposes persistence errors. */
    }
  }
  return (
    <div className="p-task-layout">
      <section className="p-main-section">
        <header className="p-page-heading">
          <div>
            <div className="p-eyebrow">把心里的事，安放在这里</div>
            <h1>
              {viewNames[view]} <span>{tasks.length}</span>
            </h1>
          </div>
          <span className="p-muted">
            {new Date().toLocaleDateString(undefined, {
              month: 'long',
              day: 'numeric',
              weekday: 'long',
            })}
          </span>
        </header>
        <div className="p-tabs" aria-label="任务视图">
          {Object.entries(viewNames).map(([key, name]) => (
            <button
              key={key}
              aria-pressed={key === view}
              onClick={() => onView(key as View)}
            >
              {name}
            </button>
          ))}
        </div>
        <QuickAdd />
        <div className="p-filters">
          <input
            id="task-search"
            type="search"
            aria-label="搜索任务"
            placeholder="搜索任务或备注  /"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            aria-label="筛选优先级"
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
          >
            <option value={0}>所有优先级</option>
            {[1, 2, 3, 4].map((p) => (
              <option key={p} value={p}>
                P{p}
              </option>
            ))}
          </select>
          <select
            aria-label="筛选标签"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          >
            <option value="">所有标签</option>
            {data.labels
              .filter((l) => !l.deletedAt)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
          </select>
        </div>
        <div className="p-task-groups">
          {groups.map(([date, rows]) => (
            <section key={date}>
              {date && (
                <h3 className="p-group-title">
                  {date} · {relativeDate(date, true)}
                </h3>
              )}
              {rows.map((t) => {
                const seconds =
                  data.sessions
                    .filter((s) => !s.deletedAt && s.taskId === t.id)
                    .reduce((n, s) => n + s.seconds, 0) +
                  (data.timer?.taskId === t.id ? elapsed(data.timer) : 0);
                return (
                  <article
                    className={`p-task-row ${selected === t.id ? 'selected' : ''} ${t.completedAt ? 'completed' : ''}`}
                    key={t.id}
                    draggable
                    onDragStart={(e) => {
                      dragged.current = t.id;
                      e.dataTransfer.setData('text/plain', t.id);
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const id = dragged.current;
                      dragged.current = null;
                      if (!id || id === t.id) return;
                      mutate((d) => {
                        const ordered = visibleTasks(
                          d,
                          view,
                          query,
                          priority,
                          label,
                        )
                          .map((t) => t.id)
                          .filter((x) => x !== id);
                        ordered.splice(ordered.indexOf(t.id), 0, id);
                        ordered.forEach((id, index) => {
                          const row = d.tasks.find((t) => t.id === id)!;
                          row.order = index;
                          row.updatedAt = Date.now();
                        });
                      });
                    }}
                  >
                    <DotsSixVertical className="p-grip" size={16} />
                    <button
                      className={`p-check priority-${t.priority}`}
                      aria-label={
                        t.completedAt
                          ? `恢复任务 ${t.title}`
                          : `完成任务 ${t.title}`
                      }
                      onClick={() => void finish(t)}
                    >
                      {t.completedAt && <Check size={14} weight="bold" />}
                    </button>
                    <button
                      className="p-task-content"
                      onClick={() => setSelected(t.id)}
                    >
                      <span className="p-task-title">{t.title}</span>
                      <span className="p-task-meta">
                        {t.due && (
                          <span
                            className={
                              t.due < dayKey() && !t.completedAt
                                ? 'p-error'
                                : ''
                            }
                          >
                            {relativeDate(t.due, data.settings.relativeDates)}{' '}
                            {formatClock(t.time, data.settings)}
                          </span>
                        )}
                        {t.repeat !== 'none' && (
                          <span>↻ {repeatNames[t.repeat]}</span>
                        )}
                        {t.subtasks.length > 0 && (
                          <span>
                            ☑ {t.subtasks.filter((s) => s.done).length}/
                            {t.subtasks.length}
                          </span>
                        )}
                        {t.labels.map((id) => {
                          const l = data.labels.find(
                            (l) => l.id === id && !l.deletedAt,
                          );
                          return (
                            l && (
                              <span
                                className="p-label-chip"
                                key={id}
                                style={{ color: l.color }}
                              >
                                #{l.name}
                              </span>
                            )
                          );
                        })}
                        {(seconds > 0 || t.estimate > 0) && (
                          <span
                            className={
                              t.estimate > 0 && seconds > t.estimate * 60
                                ? 'p-error'
                                : ''
                            }
                          >
                            {clockText(seconds)}
                            {t.estimate > 0 ? ` / ${t.estimate} 分钟` : ''}
                          </span>
                        )}
                      </span>
                      {t.subtasks.length > 0 && (
                        <progress
                          max={t.subtasks.length}
                          value={t.subtasks.filter((s) => s.done).length}
                        />
                      )}
                    </button>
                    <button
                      className={`p-icon ${t.pinned ? 'active' : ''}`}
                      aria-label={
                        t.pinned ? `取消置顶 ${t.title}` : `置顶 ${t.title}`
                      }
                      onClick={() =>
                        mutate((d) => {
                          const row = d.tasks.find((x) => x.id === t.id)!;
                          row.pinned = !row.pinned;
                          row.updatedAt = Date.now();
                        })
                      }
                    >
                      <PushPin
                        size={17}
                        weight={t.pinned ? 'fill' : 'regular'}
                      />
                    </button>
                    {!t.completedAt && (
                      <button
                        className="p-icon"
                        aria-label={`开始计时 ${t.title}`}
                        onClick={() =>
                          mutate((d) =>
                            startTimer(d, d.settings.taskTimer, t.id),
                          )
                        }
                      >
                        <Play size={17} />
                      </button>
                    )}
                  </article>
                );
              })}
            </section>
          ))}
          {!tasks.length && (
            <div className="p-empty">
              <Check size={36} />
              <h2>
                {query || label || priority
                  ? '没有匹配的任务'
                  : view === 'today'
                    ? '今天留一点从容'
                    : '这里还没有任务'}
              </h2>
              <p>
                {view === 'today'
                  ? '添加一件今天想做的事，或到收件箱整理计划。'
                  : '在上方快速记录，再按自己的节奏安排。'}
              </p>
            </div>
          )}
        </div>
        {celebration && (
          <div className="p-celebration" role="status">
            ✦ {celebration}
          </div>
        )}
      </section>
      {active && (
        <TaskDetail
          key={active.id}
          task={active}
          data={data}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

export function TaskDetail({
  task,
  data,
  onClose,
}: {
  task: Task;
  data: ProductivityData;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(task));
  const [subtask, setSubtask] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const baseRevision = useRef(task.updatedAt);
  const [estimate, setEstimate] = useState(
    task.estimate ? String(task.estimate) : '',
  );
  const set = (patch: Partial<Task>) => setDraft((d) => ({ ...d, ...patch }));
  const save = async () => {
    if (!draft.title.trim()) {
      setError('任务标题不能为空');
      return;
    }
    if (draft.time && !draft.due) {
      setError('请先选择日期');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await mutateProductivity((d) => {
        const row = d.tasks.find((t) => t.id === task.id && !t.deletedAt);
        if (!row) throw new Error('任务已经删除');
        if (row.updatedAt !== baseRevision.current)
          throw new Error('任务已在另一个窗口修改，请关闭详情后重新打开');
        const timingChanged = row.due !== draft.due || row.time !== draft.time;
        const repeatChanged =
          row.repeat !== draft.repeat || row.due !== draft.due;
        Object.assign(row, draft, {
          title: draft.title.trim(),
          estimate: estimateMinutes(estimate),
          updatedAt: Date.now(),
        });
        if (repeatChanged) row.repeatAnchor = draft.due;
        if (timingChanged) {
          row.reminderCount = 0;
          row.reminderAt = dateTime(row.due, row.time);
          row.reminderAck = false;
          row.lastNotified = null;
        }
      });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="p-detail" aria-label="任务详情">
      <header>
        <h2>任务详情</h2>
        <button className="p-icon" aria-label="关闭任务详情" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <label>
        任务
        <input
          aria-label="任务标题"
          value={draft.title}
          onChange={(e) => set({ title: e.target.value })}
        />
      </label>
      <label>
        备注
        <textarea
          aria-label="任务备注"
          rows={4}
          value={draft.notes}
          onChange={(e) => set({ notes: e.target.value })}
          placeholder="补充链接、想法或下一步…"
        />
      </label>
      <div className="p-field-row">
        <label>
          日期
          <input
            type="date"
            value={draft.due}
            onChange={(e) => set({ due: e.target.value })}
          />
        </label>
        <label>
          提醒时间
          <input
            type="time"
            value={draft.time}
            onChange={(e) => set({ time: e.target.value })}
          />
        </label>
      </div>
      <div className="p-chips">
        <button onClick={() => set({ due: dayKey() })}>今天</button>
        <button onClick={() => set({ due: addDays(dayKey(), 1) })}>明天</button>
        <button onClick={() => set({ due: '', time: '' })}>无日期</button>
        {data.settings.quickTimes.map((time) => (
          <button
            key={time}
            onClick={() => set({ due: draft.due || dayKey(), time })}
          >
            {time}
          </button>
        ))}
      </div>
      <div className="p-field-row">
        <label>
          重复
          <select
            value={draft.repeat}
            onChange={(e) => set({ repeat: e.target.value as Repeat })}
          >
            {Object.entries(repeatNames).map(([value, title]) => (
              <option key={value} value={value}>
                {title}
              </option>
            ))}
          </select>
        </label>
        <label>
          优先级
          <select
            value={draft.priority}
            onChange={(e) => set({ priority: Number(e.target.value) })}
          >
            {[1, 2, 3, 4].map((p) => (
              <option key={p} value={p}>
                P{p}
                {p === 1 ? ' · 紧急' : p === 4 ? ' · 普通' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        预估时长
        <input
          value={estimate}
          onChange={(e) => setEstimate(e.target.value)}
          placeholder="90、1h30、1.5h"
        />
      </label>
      <fieldset>
        <legend>标签</legend>
        <div className="p-chips">
          {data.labels
            .filter((l) => !l.deletedAt)
            .map((l) => (
              <label className="p-inline-check" key={l.id}>
                <input
                  type="checkbox"
                  checked={draft.labels.includes(l.id)}
                  onChange={(e) =>
                    set({
                      labels: e.target.checked
                        ? [...draft.labels, l.id]
                        : draft.labels.filter((id) => id !== l.id),
                    })
                  }
                />
                <span style={{ color: l.color }}>{l.name}</span>
              </label>
            ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>
          子任务 · {draft.subtasks.filter((s) => s.done).length}/
          {draft.subtasks.length}
        </legend>
        {draft.subtasks.map((s) => (
          <div className="p-subtask" key={s.id}>
            <input
              type="checkbox"
              aria-label={`子任务 ${s.title}`}
              checked={s.done}
              onChange={(e) =>
                set({
                  subtasks: draft.subtasks.map((x) =>
                    x.id === s.id ? { ...x, done: e.target.checked } : x,
                  ),
                })
              }
            />
            <input
              aria-label="子任务标题"
              value={s.title}
              onChange={(e) =>
                set({
                  subtasks: draft.subtasks.map((x) =>
                    x.id === s.id ? { ...x, title: e.target.value } : x,
                  ),
                })
              }
            />
            <button
              className="p-icon"
              aria-label={`删除子任务 ${s.title}`}
              onClick={() =>
                set({ subtasks: draft.subtasks.filter((x) => x.id !== s.id) })
              }
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <form
          className="p-field-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (subtask.trim()) {
              set({
                subtasks: [
                  ...draft.subtasks,
                  { id: uid(), title: subtask.trim(), done: false },
                ],
              });
              setSubtask('');
            }
          }}
        >
          <input
            aria-label="新子任务"
            placeholder="添加一个步骤"
            value={subtask}
            onChange={(e) => setSubtask(e.target.value)}
          />
          <button aria-label="添加子任务">
            <Plus size={18} />
          </button>
        </form>
      </fieldset>
      {error && (
        <p className="p-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button
          className="p-primary"
          disabled={busy}
          onClick={() => void save()}
        >
          保存修改
        </button>
        <button
          className="p-icon"
          aria-label="删除任务"
          onClick={async () => {
            if (await confirmDestructive(`删除「${task.title}」？`)) {
              try {
                await mutateProductivity((d) => {
                  const row = d.tasks.find((t) => t.id === task.id)!;
                  row.deletedAt = row.updatedAt = Date.now();
                });
                onClose();
              } catch {
                /* store error */
              }
            }
          }}
        >
          <Trash size={19} />
        </button>
      </footer>
      <button
        onClick={async () => {
          try {
            await mutateProductivity((d) => completeTask(d, task.id));
            onClose();
          } catch {
            /* store error */
          }
        }}
      >
        <ArrowCounterClockwise size={16} />{' '}
        {task.completedAt ? '恢复为未完成' : '标记完成'}
      </button>
    </aside>
  );
}
