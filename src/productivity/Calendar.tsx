import { dayBlocks, eventOnDay } from './calendarLayout';
import { formatClock } from './model';
import { useState } from 'react';
import { CaretLeft, CaretRight, Plus, X, Trash } from '@phosphor-icons/react';
import {
  addDays,
  dayKey,
  localDate,
  uid,
  weekStart,
  type CalendarEvent,
  type ProductivityData,
} from './model';
import { mutateProductivity } from './store';
import { TaskDetail } from './Tasks';
import { confirmDestructive } from '../confirm';

export default function Calendar({ data }: { data: ProductivityData }) {
  const [date, setDate] = useState(dayKey());
  const [mode, setMode] = useState<'month' | 'week' | 'day'>('month');
  const [editing, setEditing] = useState<CalendarEvent | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const first = weekStart(data.settings);
  const selected = localDate(date);
  const monthStart = new Date(selected.getFullYear(), selected.getMonth(), 1);
  const gridStart =
    mode === 'month'
      ? addDays(dayKey(monthStart), -((monthStart.getDay() - first + 7) % 7))
      : mode === 'week'
        ? addDays(date, -((selected.getDay() - first + 7) % 7))
        : date;
  const days = Array.from(
    { length: mode === 'month' ? 42 : mode === 'week' ? 7 : 1 },
    (_, i) => addDays(gridStart, i),
  );
  const task = data.tasks.find((t) => t.id === taskId && !t.deletedAt);
  function move(delta: number) {
    if (mode !== 'month')
      setDate(addDays(date, delta * (mode === 'week' ? 7 : 1)));
    else {
      const d = localDate(date);
      d.setDate(1);
      d.setMonth(d.getMonth() + delta);
      setDate(dayKey(d));
    }
  }
  function create(day: string, time = '09:00') {
    const end = new Date(new Date(`${day}T${time}:00`).getTime() + 3600000);
    setEditing({
      id: uid(),
      title: '',
      notes: '',
      start: `${day}T${time}`,
      end: `${dayKey(end)}T${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`,
      allDay: false,
      updatedAt: 0,
    });
  }
  const formatTime = (value: string) =>
    new Date(value).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12:
        data.settings.hour12 === 'system'
          ? undefined
          : data.settings.hour12 === '12',
    });
  return (
    <div className="p-task-layout">
      <section className="p-main-section p-calendar">
        <header className="p-page-heading">
          <div>
            <div className="p-eyebrow">让时间，看得见</div>
            <h1>日历</h1>
          </div>
          <button className="p-primary" onClick={() => create(date)}>
            <Plus size={17} />
            新建日程
          </button>
        </header>
        <div className="p-calendar-toolbar">
          <div className="p-field-row">
            <button
              className="p-icon"
              aria-label="上一页日历"
              onClick={() => move(-1)}
            >
              <CaretLeft />
            </button>
            <input
              aria-label="跳转日期"
              type="date"
              value={date}
              onChange={(e) => e.target.value && setDate(e.target.value)}
            />
            <button
              className="p-icon"
              aria-label="下一页日历"
              onClick={() => move(1)}
            >
              <CaretRight />
            </button>
            <button onClick={() => setDate(dayKey())}>今天</button>
          </div>
          <div className="p-tabs">
            {(['month', 'week', 'day'] as const).map((m) => (
              <button
                key={m}
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
              >
                {{ month: '月', week: '周', day: '日' }[m]}
              </button>
            ))}
          </div>
        </div>
        <h2>
          {selected.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'long',
          })}
        </h2>
        {mode === 'month' && (
          <div className="p-calendar-weekdays">
            {Array.from({ length: 7 }, (_, i) => (
              <span key={i}>
                {
                  ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][
                    (i + first) % 7
                  ]
                }
              </span>
            ))}
          </div>
        )}
        <div className={`p-calendar-grid ${mode}`}>
          {days.map((day) => {
            const tasks = data.tasks.filter(
              (t) => !t.deletedAt && !t.completedAt && t.due === day,
            );
            const events = data.events
              .filter((e) => eventOnDay(e, day))
              .sort(
                (a, b) =>
                  Number(b.allDay) - Number(a.allDay) ||
                  a.start.localeCompare(b.start),
              );
            const journaled = data.journals.some(
              (j) => !j.deletedAt && j.date === day,
            );
            return (
              <div
                className={`p-calendar-day ${day === dayKey() ? 'today' : ''} ${day.slice(0, 7) !== date.slice(0, 7) ? 'outside' : ''}`}
                key={day}
              >
                <header>
                  <button
                    aria-label={`查看 ${day}`}
                    onClick={() => {
                      setDate(day);
                      setMode('day');
                    }}
                  >
                    {mode === 'month'
                      ? Number(day.slice(-2))
                      : localDate(day).toLocaleDateString(undefined, {
                          weekday: 'short',
                          day: 'numeric',
                        })}
                    {journaled && (
                      <span title="这一天有日记" className="p-journal-dot">
                        {' '}
                        •
                      </span>
                    )}
                  </button>
                  <button
                    className="p-icon"
                    aria-label={`为 ${day} 添加日程`}
                    onClick={() => create(day)}
                  >
                    <Plus size={14} />
                  </button>
                </header>
                {tasks
                  .filter((t) => mode === 'month' || !t.time)
                  .map((t) => (
                    <button
                      className={`p-calendar-item task priority-${t.priority}`}
                      key={t.id}
                      onClick={() => setTaskId(t.id)}
                    >
                      ○ {formatClock(t.time, data.settings)} {t.title}
                    </button>
                  ))}
                {events
                  .filter((e) => mode === 'month' || e.allDay)
                  .map((e) => (
                    <button
                      className="p-calendar-item event"
                      key={e.id}
                      onClick={() => setEditing(structuredClone(e))}
                    >
                      {e.allDay ? '全天' : formatTime(e.start)} · {e.title}
                    </button>
                  ))}
                {mode !== 'month' && (
                  <div className="p-time-grid">
                    {Array.from({ length: 24 }, (_, h) => (
                      <button
                        className="p-hour-slot"
                        key={h}
                        style={{ top: `${(h / 24) * 100}%` }}
                        aria-label={`${day} ${h}:00 添加日程`}
                        onClick={() =>
                          create(day, `${String(h).padStart(2, '0')}:00`)
                        }
                      >
                        <time>
                          {formatClock(
                            `${String(h).padStart(2, '0')}:00`,
                            data.settings,
                          )}
                        </time>
                      </button>
                    ))}
                    {dayBlocks(data, day).map((block) => (
                      <button
                        key={`${block.kind}:${block.id}`}
                        className={`p-time-block ${block.kind}`}
                        style={{
                          top: `${(block.start / 1440) * 100}%`,
                          height: `${((block.end - block.start) / 1440) * 100}%`,
                          left: `calc(44px + (100% - 44px) * ${block.lane / block.lanes})`,
                          width: `calc((100% - 44px) / ${block.lanes} - 3px)`,
                        }}
                        onClick={() => {
                          if (block.kind === 'task') setTaskId(block.id);
                          else {
                            const event = data.events.find(
                              (e) => e.id === block.id,
                            );
                            if (event) setEditing(structuredClone(event));
                          }
                        }}
                      >
                        <strong>{block.title}</strong>
                        <time>
                          {formatClock(
                            `${String(Math.floor(block.start / 60)).padStart(2, '0')}:${String(block.start % 60).padStart(2, '0')}`,
                            data.settings,
                          )}
                        </time>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
      {task && (
        <TaskDetail
          key={task.id}
          task={task}
          data={data}
          onClose={() => setTaskId(null)}
        />
      )}
      {editing && (
        <EventEditor
          key={editing.id}
          event={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
function EventEditor({
  event,
  onClose,
}: {
  event: CalendarEvent;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(event);
  const [error, setError] = useState('');
  const patch = (p: Partial<CalendarEvent>) =>
    setDraft((d) => ({ ...d, ...p }));
  return (
    <aside className="p-detail" aria-label="日程详情">
      <header>
        <h2>{event.updatedAt ? '编辑日程' : '新建日程'}</h2>
        <button className="p-icon" aria-label="关闭日程" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!draft.title.trim()) {
            setError('请填写日程标题');
            return;
          }
          if (
            draft.end < draft.start ||
            (!draft.allDay && draft.end === draft.start)
          ) {
            setError('结束时间需要晚于开始时间');
            return;
          }
          try {
            await mutateProductivity((d) => {
              const index = d.events.findIndex((x) => x.id === draft.id);
              const row = {
                ...draft,
                title: draft.title.trim(),
                updatedAt: Date.now(),
              };
              if (index < 0) d.events.push(row);
              else {
                if (d.events[index].updatedAt !== event.updatedAt)
                  throw new Error('日程已被修改，请重新打开');
                d.events[index] = row;
              }
            });
            onClose();
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        <label>
          日程标题
          <input
            autoFocus
            value={draft.title}
            onChange={(e) => patch({ title: e.target.value })}
          />
        </label>
        <label className="p-inline-check">
          <input
            type="checkbox"
            checked={draft.allDay}
            onChange={(e) => patch({ allDay: e.target.checked })}
          />
          全天
        </label>
        <label>
          开始
          <input
            type={draft.allDay ? 'date' : 'datetime-local'}
            required
            value={draft.allDay ? draft.start.slice(0, 10) : draft.start}
            onChange={(e) =>
              patch({
                start: draft.allDay
                  ? `${e.target.value}T00:00`
                  : e.target.value,
              })
            }
          />
        </label>
        <label>
          结束
          <input
            type={draft.allDay ? 'date' : 'datetime-local'}
            required
            value={draft.allDay ? draft.end.slice(0, 10) : draft.end}
            onChange={(e) =>
              patch({
                end: draft.allDay ? `${e.target.value}T23:59` : e.target.value,
              })
            }
          />
        </label>
        <label>
          备注
          <textarea
            rows={6}
            value={draft.notes}
            onChange={(e) => patch({ notes: e.target.value })}
          />
        </label>
        {error && (
          <p role="alert" className="p-error">
            {error}
          </p>
        )}
        <button className="p-primary">保存日程</button>
      </form>
      {event.updatedAt > 0 && (
        <button
          onClick={async () => {
            if (await confirmDestructive(`删除日程「${event.title}」？`)) {
              try {
                await mutateProductivity((d) => {
                  const row = d.events.find((x) => x.id === event.id)!;
                  row.deletedAt = row.updatedAt = Date.now();
                });
                onClose();
              } catch (e) {
                setError(String(e));
              }
            }
          }}
        >
          <Trash size={16} />
          删除日程
        </button>
      )}
    </aside>
  );
}
