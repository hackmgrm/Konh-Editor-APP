import { formatClock } from './model';
import { memo, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { restoreCloud, syncNow } from './cloud';
import {
  CheckSquare,
  CalendarBlank,
  Timer,
  Notebook,
  PencilLine,
  Tag,
  Gear,
  Question,
  X,
} from '@phosphor-icons/react';
import App from '../App';
import { useAppearance } from '../store/appearance';
import { useProductivity, mutateProductivity } from './store';
import { completeTask, dayKey, elapsed, streakDays, type View } from './model';
import { QuickAdd, TaskList } from './Tasks';
import Calendar from './Calendar';
import Focus, { TimerControls } from './Focus';
import Journal from './Journal';
import Settings, { Labels } from './Settings';
import './productivity.css';

const WritingApp = memo(App);
type Page =
  | 'writing'
  | 'tasks'
  | 'calendar'
  | 'focus'
  | 'journal'
  | 'labels'
  | 'settings';
const pages = [
  ['writing', '写作', PencilLine],
  ['tasks', '任务', CheckSquare],
  ['calendar', '日历', CalendarBlank],
  ['focus', '专注', Timer],
  ['journal', '日记', Notebook],
  ['labels', '标签', Tag],
  ['settings', '设置', Gear],
] as const;
export default function Shell() {
  useAppearance();
  const { data, ready, error } = useProductivity();
  const [page, setPage] = useState<Page>('tasks');
  const [view, setView] = useState<View>('today');
  const [help, setHelp] = useState(false);
  const [, tick] = useState(0);
  const [writingMounted, setWritingMounted] = useState(false);
  const surface = new URLSearchParams(location.search).get('surface');
  useEffect(() => {
    if (surface || !ready) return;
    void restoreCloud()
      .then(() => syncNow())
      .catch(() => {});
    const interval = window.setInterval(() => {
      void syncNow().catch(() => {});
    }, 60000);
    return () => clearInterval(interval);
  }, [surface, ready]);
  useEffect(() => {
    if (surface !== 'quickadd') return;
    document.getElementById('task-quick-add')?.focus();
    const unlisten = listen('productivity-focus-input', () =>
      document.getElementById('task-quick-add')?.focus(),
    );
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape')
        void invoke('productivity_hide_surface', { label: 'quickadd' });
    };
    window.addEventListener('keydown', escape);
    return () => {
      void unlisten.then((fn) => fn());
      window.removeEventListener('keydown', escape);
    };
  }, [surface]);
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement)?.closest(
          'input, textarea, select, [contenteditable="true"]',
        ) ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        page === 'writing'
      )
        return;
      if (e.key === '?') {
        e.preventDefault();
        setHelp((h) => !h);
      }
      if (e.key === 'J' && e.shiftKey) {
        e.preventDefault();
        setPage('journal');
      }
      if (e.key.toLowerCase() === 'n' || e.key === '/') {
        e.preventDefault();
        setPage('tasks');
        requestAnimationFrame(() =>
          document
            .getElementById(e.key === '/' ? 'task-search' : 'task-quick-add')
            ?.focus(),
        );
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [page]);
  const navigate = (next: Page) => {
    if (next === 'writing') setWritingMounted(true);
    setPage(next);
  };
  if (surface === 'quickadd')
    return (
      <div className="productivity p-floating">
        <header data-tauri-drag-region>
          <strong>快速记录</strong>
          <button
            className="p-icon"
            aria-label="关闭快速添加"
            onClick={() =>
              void invoke('productivity_hide_surface', { label: 'quickadd' })
            }
          >
            <X size={18} />
          </button>
        </header>
        {error && <p className="p-error">{error}</p>}
        <QuickAdd
          compact
          onAdded={() => {
            void invoke('productivity_hide_surface', { label: 'quickadd' });
          }}
        />
        <p className="p-muted">
          日期、#标签、p1–p4、每天／每周，直接输入即可。
        </p>
      </div>
    );
  if (surface === 'reminder') return <ReminderSurface />;
  return (
    <div className="p-app-shell">
      <header className="p-appbar" data-tauri-drag-region>
        <div className="p-brand" data-tauri-drag-region>
          <span>◉</span> 空核
          <span className="p-brand-sub">把生活与创作放在一起</span>
        </div>
        <nav aria-label="应用导航">
          {pages.map(([key, label, Icon]) => (
            <button
              key={key}
              aria-current={page === key ? 'page' : undefined}
              onClick={() => navigate(key)}
            >
              <Icon size={17} weight={page === key ? 'fill' : 'regular'} />
              {label}
            </button>
          ))}
        </nav>
        <button
          className="p-help"
          aria-label="快捷键说明"
          onClick={() => setHelp(true)}
        >
          <Question size={19} />
        </button>
      </header>
      {writingMounted && (
        <div className="p-writing-host" hidden={page !== 'writing'}>
          <WritingApp />
        </div>
      )}
      {page !== 'writing' && (
        <div className="productivity p-productivity-host">
          {error && (
            <div className="p-error-banner" role="alert">
              {error}
            </div>
          )}
          {!ready ? (
            <div className="p-empty">
              {error
                ? '无法载入效率数据，请检查磁盘后重新启动。'
                : '正在打开效率中心…'}
            </div>
          ) : (
            <>
              {page === 'tasks' && (
                <TaskList data={data} view={view} onView={setView} />
              )}
              {page === 'calendar' && <Calendar data={data} />}
              {page === 'focus' && <Focus data={data} />}
              {page === 'journal' && <Journal data={data} />}
              {page === 'labels' && <Labels data={data} />}
              {page === 'settings' && <Settings data={data} />}
            </>
          )}
        </div>
      )}
      <footer className="p-app-footer">
        <span>
          ◌ 本地优先
          {data.settings.streak && ` · 连续完成 ${streakDays(data)} 天`}
        </span>
        {data.timer ? (
          <TimerControls data={data} compact />
        ) : (
          <span>{dayKey()} · 随时开始一件小事</span>
        )}
      </footer>
      {help && (
        <div
          className="productivity p-modal-backdrop"
          onClick={() => setHelp(false)}
        >
          <section
            className="p-help-card"
            role="dialog"
            aria-modal="true"
            aria-label="快捷键说明"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <h2>快捷键</h2>
              <button
                className="p-icon"
                aria-label="关闭快捷键说明"
                onClick={() => setHelp(false)}
              >
                <X size={20} />
              </button>
            </header>
            <p>
              <kbd>Ctrl Alt A</kbd> 全局快速添加
            </p>
            <p>
              <kbd>N</kbd> 新任务　<kbd>/</kbd> 搜索
            </p>
            <p>
              <kbd>Shift J</kbd> 日记　<kbd>?</kbd> 打开帮助
            </p>
            <p>
              <kbd>Tab</kbd> 导航　<kbd>Enter / 空格</kbd> 操作按钮
            </p>
            <p className="p-muted">
              单键快捷键只在效率中心生效，输入时不会触发。
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
function ReminderSurface() {
  const { data, error } = useProductivity();
  const tasks = data.tasks.filter(
    (t) =>
      !t.deletedAt &&
      !t.completedAt &&
      !t.reminderAck &&
      t.lastNotified &&
      t.reminderAt &&
      t.reminderAt <= Date.now(),
  );
  const timerDue =
    data.timer &&
    data.timer.target > 0 &&
    elapsed(data.timer) >= data.timer.target &&
    data.timer.notified;
  const dismiss = () =>
    void invoke('productivity_hide_surface', { label: 'reminder' });
  return (
    <div className="productivity p-floating p-reminders">
      <header data-tauri-drag-region>
        <strong>时间到了</strong>
        <button className="p-icon" aria-label="关闭提醒窗口" onClick={dismiss}>
          <X size={18} />
        </button>
      </header>
      {error && <p className="p-error">{error}</p>}
      {tasks.map((t) => (
        <article key={t.id}>
          <h2>{t.title}</h2>
          <p className="p-muted">
            {t.due} {formatClock(t.time, data.settings)}
          </p>
          <div className="p-field-row">
            <button
              className="p-primary"
              onClick={() => {
                void mutateProductivity((d) => completeTask(d, t.id))
                  .then(() => {
                    if (tasks.length === 1 && !timerDue) dismiss();
                  })
                  .catch(() => {});
              }}
            >
              完成
            </button>
            <button
              onClick={() => {
                void mutateProductivity((d) => {
                  const row = d.tasks.find((x) => x.id === t.id)!;
                  row.reminderAt = Date.now() + 10 * 60000;
                  row.lastNotified = null;
                  row.updatedAt = Date.now();
                })
                  .then(() => {
                    if (tasks.length === 1 && !timerDue) dismiss();
                  })
                  .catch(() => {});
              }}
            >
              10 分钟后
            </button>
            <button
              onClick={() => {
                void mutateProductivity((d) => {
                  const row = d.tasks.find((x) => x.id === t.id)!;
                  row.reminderAck = true;
                  row.updatedAt = Date.now();
                })
                  .then(() => {
                    if (tasks.length === 1 && !timerDue) dismiss();
                  })
                  .catch(() => {});
              }}
            >
              知道了
            </button>
          </div>
        </article>
      ))}
      {timerDue && (
        <article>
          <h2>本次计时已到预定时间</h2>
          <p>计时仍在继续，准备好后可以停止或切换休息。</p>
          <TimerControls data={data} />
        </article>
      )}
      {!tasks.length && !timerDue && <p>当前没有待处理的提醒。</p>}
    </div>
  );
}
