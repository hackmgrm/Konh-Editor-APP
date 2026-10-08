import { useState } from 'react';
import { Play, Pause, Stop } from '@phosphor-icons/react';
import {
  addDays,
  clockText,
  dayKey,
  elapsed,
  startTimer,
  stopTimer,
  toggleTimer,
  weekStart,
  type ProductivityData,
  type Timer,
} from './model';
import { mutateProductivity } from './store';
export const timerNames: Record<Timer['kind'], string> = {
  focus: '专注',
  stopwatch: '任务计时',
  shortBreak: '短休息',
  longBreak: '长休息',
};
export function TimerControls({
  data,
  compact = false,
}: {
  data: ProductivityData;
  compact?: boolean;
}) {
  const t = data.timer;
  if (!t) return null;
  const seconds = elapsed(t);
  const remaining = t.target ? t.target - seconds : seconds;
  const change = (fn: (d: ProductivityData) => void) => {
    void mutateProductivity(fn).catch(() => {});
  };
  return (
    <div className={compact ? 'p-mini-timer' : 'p-live-timer'}>
      <span>
        {timerNames[t.kind]}
        {t.taskTitle && ` · ${t.taskTitle}`}
      </span>
      <strong className={remaining < 0 ? 'p-error' : ''}>
        {remaining < 0 ? '+' : ''}
        {clockText(Math.abs(remaining))}
      </strong>
      <button
        className="p-icon"
        aria-label={t.startedAt === null ? '继续计时' : '暂停计时'}
        onClick={() => change((d) => toggleTimer(d))}
      >
        {t.startedAt === null ? <Play size={20} /> : <Pause size={20} />}
      </button>
      <button
        className="p-icon"
        aria-label="停止计时"
        onClick={() => change((d) => stopTimer(d))}
      >
        <Stop size={20} />
      </button>
      {!compact && t.target > 0 && seconds >= t.target && (
        <p>本阶段时间已到。计时仍在继续，准备好后再切换。</p>
      )}
    </div>
  );
}
export default function Focus({ data }: { data: ProductivityData }) {
  const [taskId, setTaskId] = useState('');
  const [range, setRange] = useState<'today' | 'week' | 'all'>('today');
  const today = dayKey();
  const start = addDays(
    today,
    -((new Date().getDay() - weekStart(data.settings) + 7) % 7),
  );
  const sessions = data.sessions
    .filter(
      (s) =>
        !s.deletedAt &&
        (range === 'all' ||
          dayKey(new Date(s.endedAt)) >= (range === 'today' ? today : start)),
    )
    .sort((a, b) => b.endedAt - a.endedAt);
  const total = sessions.reduce((n, s) => n + s.seconds, 0);
  const days = [...new Set(sessions.map((s) => dayKey(new Date(s.endedAt))))];
  const begin = (kind: Timer['kind']) => {
    void mutateProductivity((d) => startTimer(d, kind, taskId || null)).catch(
      () => {},
    );
  };
  return (
    <section className="p-main-section p-focus">
      <header className="p-page-heading">
        <div>
          <div className="p-eyebrow">一次，只做好一件事</div>
          <h1>专注</h1>
        </div>
        <span className="p-muted">已完成 {data.focusRound} 轮番茄钟</span>
      </header>
      <div className="p-focus-card">
        <div className="p-orbit" aria-hidden="true">
          <span>◌</span>
        </div>
        {data.timer ? (
          <TimerControls data={data} />
        ) : (
          <div className="p-idle-timer">
            <span>留一段完整的时间给自己</span>
            <strong>{data.settings.focusMinutes}:00</strong>
          </div>
        )}
        <select
          aria-label="关联计时任务"
          value={taskId}
          onChange={(e) => setTaskId(e.target.value)}
        >
          <option value="">自由专注 · 不关联任务</option>
          {data.tasks
            .filter((t) => !t.deletedAt && !t.completedAt)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
        </select>
        <div className="p-focus-actions">
          <button className="p-primary" onClick={() => begin('focus')}>
            <Play size={18} />
            开始专注
          </button>
          <button onClick={() => begin('stopwatch')}>秒表</button>
          <button onClick={() => begin('shortBreak')}>短休息</button>
          <button onClick={() => begin('longBreak')}>长休息</button>
        </div>
        <p className="p-muted">
          {data.settings.focusMinutes} 分钟专注 ·{' '}
          {data.settings.shortBreakMinutes} 分钟短休息 · 每{' '}
          {data.settings.longBreakEvery} 轮长休息{' '}
          {data.settings.longBreakMinutes} 分钟
        </p>
        {data.focusRound > 0 && (
          <p className="p-muted">
            下一次建议：
            {data.focusRound % data.settings.longBreakEvery === 0
              ? '长休息'
              : '短休息'}
          </p>
        )}
      </div>
      <header className="p-section-heading">
        <h2>专注记录</h2>
        <div className="p-tabs">
          {(['today', 'week', 'all'] as const).map((r) => (
            <button
              key={r}
              aria-pressed={range === r}
              onClick={() => setRange(r)}
            >
              {{ today: '今天', week: '本周', all: '全部' }[r]}
            </button>
          ))}
        </div>
      </header>
      <div className="p-stats">
        <div>
          <strong>{Math.floor(total / 60)}</strong>
          <span>累计分钟</span>
        </div>
        <div>
          <strong>{sessions.length}</strong>
          <span>专注次数</span>
        </div>
        <div>
          <strong>{days.length}</strong>
          <span>有记录的天数</span>
        </div>
      </div>
      {days.map((day) => (
        <section key={day}>
          <h3 className="p-group-title">{day}</h3>
          {sessions
            .filter((s) => dayKey(new Date(s.endedAt)) === day)
            .map((s) => (
              <div className="p-history-row" key={s.id}>
                <div>
                  <strong>{s.taskTitle || '自由专注'}</strong>
                  <span>
                    {timerNames[s.kind]} ·{' '}
                    {new Date(s.startedAt).toLocaleTimeString(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12:
                        data.settings.hour12 === 'system'
                          ? undefined
                          : data.settings.hour12 === '12',
                    })}
                  </span>
                </div>
                <time>{clockText(s.seconds)}</time>
              </div>
            ))}
        </section>
      ))}
      {!sessions.length && (
        <p className="p-empty">开始一段专注，记录会在停止计时后出现在这里。</p>
      )}
    </section>
  );
}
