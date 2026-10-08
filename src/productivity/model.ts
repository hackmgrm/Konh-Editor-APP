import * as chrono from 'chrono-node';

export type Repeat =
  'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly';
export type View =
  'today' | 'upcoming' | 'inbox' | 'all' | 'pinned' | 'completed';
export interface RecordBase {
  id: string;
  updatedAt: number;
  deletedAt?: number;
}
export interface Task extends RecordBase {
  title: string;
  notes: string;
  due: string;
  time: string;
  priority: number;
  labels: string[];
  repeat: Repeat;
  repeatAnchor?: string;
  reminderCount?: number;
  pinned: boolean;
  order: number;
  createdAt: number;
  completedAt: number | null;
  subtasks: { id: string; title: string; done: boolean }[];
  estimate: number;
  reminderAt: number | null;
  reminderAck: boolean;
  lastNotified: number | null;
}
export interface Label extends RecordBase {
  name: string;
  color: string;
}
export interface CalendarEvent extends RecordBase {
  title: string;
  notes: string;
  start: string;
  end: string;
  allDay: boolean;
}
export interface Journal extends RecordBase {
  title: string;
  body: string;
  date: string;
  mood: number;
}
export interface Session extends RecordBase {
  taskId: string | null;
  taskTitle: string;
  startedAt: number;
  endedAt: number;
  seconds: number;
  kind: 'focus' | 'stopwatch';
}
export interface Completion extends RecordBase {
  taskId: string;
  title: string;
  completedAt: number;
}
export interface Timer {
  taskId: string | null;
  taskTitle: string;
  kind: 'focus' | 'stopwatch' | 'shortBreak' | 'longBreak';
  startedAt: number | null;
  accumulated: number;
  target: number;
  notified: boolean;
  createdAt: number;
}
export interface Settings {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  longBreakEvery: number;
  taskTimer: 'focus' | 'stopwatch';
  hour12: 'system' | '12' | '24';
  weekStart: 'system' | '0' | '1';
  relativeDates: boolean;
  celebrate: boolean;
  streak: boolean;
  closeToTray: boolean;
  startHidden: boolean;
  reminderMode: 'system' | 'popup';
  reminderRepeat: number;
  sound: boolean;
  soundData: string;
  volume: number;
  ramp: boolean;
  quickTimes: string[];
  popupCorner: 'bottom-right' | 'top-right' | 'bottom-left' | 'top-left';
}
export interface ProductivityData {
  syncOwner?: string;
  schema: 1;
  tasks: Task[];
  labels: Label[];
  events: CalendarEvent[];
  journals: Journal[];
  sessions: Session[];
  completions: Completion[];
  timer: Timer | null;
  focusRound: number;
  settings: Settings;
}
export const repeatNames: Record<Repeat, string> = {
  none: '不重复',
  daily: '每天',
  weekdays: '每个工作日',
  weekly: '每周',
  monthly: '每月',
  yearly: '每年',
};
export const viewNames: Record<View, string> = {
  today: '今天',
  upcoming: '即将到期',
  inbox: '收件箱',
  all: '全部任务',
  pinned: '置顶',
  completed: '已完成',
};
export const uid = () => crypto.randomUUID();
export function emptyData(): ProductivityData {
  return {
    schema: 1,
    tasks: [],
    labels: [],
    events: [],
    journals: [],
    sessions: [],
    completions: [],
    timer: null,
    focusRound: 0,
    settings: {
      focusMinutes: 25,
      shortBreakMinutes: 5,
      longBreakMinutes: 15,
      longBreakEvery: 4,
      taskTimer: 'stopwatch',
      hour12: 'system',
      weekStart: 'system',
      relativeDates: true,
      celebrate: true,
      streak: true,
      closeToTray: true,
      startHidden: false,
      reminderMode: 'popup',
      reminderRepeat: 0,
      sound: true,
      soundData: '',
      volume: 0.5,
      ramp: false,
      quickTimes: ['09:00', '14:00', '18:00'],
      popupCorner: 'bottom-right',
    },
  };
}
export function dayKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function localDate(date: string): Date {
  return new Date(`${date}T12:00:00`);
}
export function addDays(date: string, days: number): string {
  const d = localDate(date);
  d.setDate(d.getDate() + days);
  return dayKey(d);
}
export function dateTime(date: string, time: string): number | null {
  return date && time ? new Date(`${date}T${time}:00`).getTime() : null;
}
export function nextDue(
  due: string,
  repeat: Repeat,
  today = dayKey(),
  anchorDate = due,
): string {
  if (repeat === 'none') return due;
  let next = due || today;
  // Advance from the original schedule, skipping missed occurrences. Clamp short months.
  const anchor = localDate(anchorDate || next).getDate();
  const month = localDate(anchorDate || next).getMonth();
  do {
    const d = localDate(next);
    if (repeat === 'monthly' || repeat === 'yearly') {
      d.setDate(1);
      if (repeat === 'monthly') d.setMonth(d.getMonth() + 1);
      else {
        d.setFullYear(d.getFullYear() + 1);
        d.setMonth(month);
      }
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(anchor, last));
    } else {
      d.setDate(d.getDate() + (repeat === 'weekly' ? 7 : 1));
      if (repeat === 'weekdays')
        while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() + 1);
    }
    next = dayKey(d);
  } while (next <= today);
  return next;
}
export function newTask(title: string, now = Date.now()): Task {
  return {
    id: uid(),
    title: title.trim(),
    notes: '',
    due: '',
    time: '',
    priority: 4,
    labels: [],
    repeat: 'none',
    pinned: false,
    order: now,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    subtasks: [],
    estimate: 0,
    reminderAt: null,
    reminderAck: false,
    lastNotified: null,
  };
}
export function completeTask(
  data: ProductivityData,
  id: string,
  now = Date.now(),
): void {
  const task = data.tasks.find((t) => t.id === id && !t.deletedAt);
  if (!task) return;
  task.updatedAt = now;
  if (task.completedAt) {
    task.completedAt = null;
    task.reminderAck = false;
    return;
  }
  data.completions.push({
    id: uid(),
    taskId: id,
    title: task.title,
    completedAt: now,
    updatedAt: now,
  });
  if (task.repeat === 'none') {
    task.completedAt = now;
    task.reminderAck = true;
  } else {
    task.repeatAnchor ||= task.due || dayKey(new Date(now));
    task.due = nextDue(
      task.due,
      task.repeat,
      dayKey(new Date(now)),
      task.repeatAnchor,
    );
    task.reminderCount = 0;
    task.reminderAt = dateTime(task.due, task.time);
    task.reminderAck = false;
    task.lastNotified = null;
    task.subtasks.forEach((s) => {
      s.done = false;
    });
  }
}
export function visibleTasks(
  data: ProductivityData,
  view: View,
  query = '',
  priority = 0,
  label = '',
  today = dayKey(),
): Task[] {
  return data.tasks
    .filter(
      (t) =>
        !t.deletedAt &&
        (view === 'completed' ? !!t.completedAt : !t.completedAt),
    )
    .filter((t) => view !== 'today' || (!!t.due && t.due <= today))
    .filter((t) => view !== 'upcoming' || (!!t.due && t.due > today))
    .filter((t) => view !== 'inbox' || !t.due)
    .filter((t) => view !== 'pinned' || t.pinned)
    .filter((t) => !priority || t.priority === priority)
    .filter((t) => !label || t.labels.includes(label))
    .filter((t) =>
      `${t.title}\n${t.notes}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
    )
    .sort((a, b) =>
      view === 'completed'
        ? (b.completedAt ?? 0) - (a.completedAt ?? 0)
        : view === 'upcoming' && a.due !== b.due
          ? a.due.localeCompare(b.due)
          : Number(b.pinned) - Number(a.pinned) || a.order - b.order,
    );
}
export function elapsed(timer: Timer | null, now = Date.now()): number {
  return timer
    ? timer.accumulated +
        (timer.startedAt === null
          ? 0
          : Math.max(0, (now - timer.startedAt) / 1000))
    : 0;
}
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m >= 60 ? `${Math.floor(m / 60)}:` : ''}${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
export function stopTimer(data: ProductivityData, now = Date.now()): void {
  const t = data.timer;
  if (!t) return;
  const seconds = Math.floor(elapsed(t, now));
  if ((t.kind === 'focus' || t.kind === 'stopwatch') && seconds > 0) {
    data.sessions.push({
      id: uid(),
      taskId: t.taskId,
      taskTitle: t.taskTitle,
      startedAt: t.createdAt,
      endedAt: now,
      seconds,
      kind: t.kind,
      updatedAt: now,
    });
    if (t.kind === 'focus' && seconds >= t.target) data.focusRound++;
  }
  data.timer = null;
}
export function startTimer(
  data: ProductivityData,
  kind: Timer['kind'],
  taskId: string | null = null,
  now = Date.now(),
): void {
  stopTimer(data, now);
  const minutes =
    kind === 'focus'
      ? data.settings.focusMinutes
      : kind === 'shortBreak'
        ? data.settings.shortBreakMinutes
        : kind === 'longBreak'
          ? data.settings.longBreakMinutes
          : 0;
  data.timer = {
    taskId,
    taskTitle: data.tasks.find((t) => t.id === taskId)?.title ?? '',
    kind,
    startedAt: now,
    accumulated: 0,
    target: minutes * 60,
    notified: false,
    createdAt: now,
  };
}
export function toggleTimer(data: ProductivityData, now = Date.now()): void {
  const t = data.timer;
  if (!t) return;
  if (t.startedAt === null) t.startedAt = now;
  else {
    t.accumulated = elapsed(t, now);
    t.startedAt = null;
  }
}
export function estimateMinutes(text: string): number {
  if (/^\d+(\.\d+)?$/.test(text.trim())) return Number(text);
  const h = text.match(/(\d+(?:\.\d+)?)\s*(?:h|小时)/i);
  const m =
    text.match(/(\d+(?:\.\d+)?)\s*(?:m|分钟)/i) ?? text.match(/h\s*(\d+)$/i);
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}
export function parseQuickAdd(
  input: string,
  now = new Date(),
): {
  title: string;
  due: string;
  time: string;
  priority: number;
  labels: string[];
  repeat: Repeat;
} {
  let text = input;
  const labels: string[] = [];
  let priority = 4;
  let repeat: Repeat = 'none';
  text = text.replace(/(?:^|\s)#([^\s#]+)/gu, (_all, name: string) => {
    labels.push(name);
    return ' ';
  });
  text = text.replace(/\bp([1-4])\b/i, (_all, p: string) => {
    priority = Number(p);
    return '';
  });
  const rules: [RegExp, Repeat][] = [
    [/每个?工作日|every weekday/i, 'weekdays'],
    [/每天|每日|every day|daily/i, 'daily'],
    [/每周|每星期|every week|weekly/i, 'weekly'],
    [/每月|every month|monthly/i, 'monthly'],
    [/每年|every year|yearly/i, 'yearly'],
  ];
  for (const [pattern, value] of rules)
    if (pattern.test(text)) {
      repeat = value;
      text = text.replace(pattern, ' ');
      break;
    }
  let due = '';
  let time = '';
  const relative = text.match(/大后天|后天|明天|今天/);
  if (relative) {
    due = addDays(
      dayKey(now),
      ({ 今天: 0, 明天: 1, 后天: 2, 大后天: 3 } as Record<string, number>)[
        relative[0]
      ],
    );
    text = text.replace(relative[0], ' ');
  }
  const weekday = text.match(/(下|本|这)?(?:周|星期)([一二三四五六日天])/);
  if (weekday) {
    const target = '日一二三四五六'.indexOf(
      weekday[2] === '天' ? '日' : weekday[2],
    );
    let delta = (target - now.getDay() + 7) % 7;
    if (weekday[1] === '下')
      delta = ((target + 6) % 7) - ((now.getDay() + 6) % 7) + 7;
    due = addDays(dayKey(now), delta);
    text = text.replace(weekday[0], ' ');
  }
  const chineseTime = text.match(
    /(上午|下午|晚上|早上|中午)?\s*(\d{1,2})[点时](半|\d{1,2}分?)?/,
  );
  if (chineseTime) {
    let hour = Number(chineseTime[2]);
    const minute =
      chineseTime[3] === '半' ? 30 : parseInt(chineseTime[3] || '0');
    if (['下午', '晚上', '中午'].includes(chineseTime[1]) && hour < 12)
      hour += 12;
    if (hour < 24 && minute < 60) {
      time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      text = text.replace(chineseTime[0], ' ');
    }
  }
  const results = chrono.parse(text, due ? localDate(due) : now, {
    forwardDate: true,
  });
  if (results[0]) {
    const r = results[0];
    const date = r.start.date();
    if (!due || r.start.isCertain('day')) due = dayKey(date);
    if (r.start.isCertain('hour'))
      time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    text = text.slice(0, r.index) + text.slice(r.index + r.text.length);
  }
  if (!due && (time || repeat !== 'none')) due = dayKey(now);
  return {
    title: text.replace(/\s+/g, ' ').trim(),
    due,
    time,
    priority,
    labels,
    repeat,
  };
}
export function addQuickTask(data: ProductivityData, input: string): string {
  const parsed = parseQuickAdd(input);
  if (!parsed.title) throw new Error('请输入任务内容');
  const task = { ...newTask(parsed.title), ...parsed, labels: [] as string[] };
  for (const name of parsed.labels) {
    let label = data.labels.find(
      (l) =>
        !l.deletedAt && l.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (!label) {
      label = { id: uid(), name, color: '#d97757', updatedAt: Date.now() };
      data.labels.push(label);
    }
    task.labels.push(label.id);
  }
  task.reminderAt = dateTime(task.due, task.time);
  data.tasks.push(task);
  return task.id;
}
export function weekStart(settings: Settings): number {
  if (settings.weekStart !== 'system') return Number(settings.weekStart);
  const locale = new Intl.Locale(navigator.language) as Intl.Locale & {
    weekInfo?: { firstDay: number };
    getWeekInfo?: () => { firstDay: number };
  };
  return (
    (locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay ?? 1) % 7
  );
}
export function dailySummary(data: ProductivityData, date: string): string {
  const done = data.completions.filter(
    (c) => !c.deletedAt && dayKey(new Date(c.completedAt)) === date,
  );
  const sessions = data.sessions.filter(
    (s) => !s.deletedAt && dayKey(new Date(s.endedAt)) === date,
  );
  return `## 今日完成\n${done.length ? done.map((c) => `- ${c.title}`).join('\n') : '- 暂无完成任务'}\n\n## 专注\n共 ${Math.round(sessions.reduce((n, s) => n + s.seconds, 0) / 60)} 分钟，${sessions.length} 次记录。`;
}
export function streakDays(data: ProductivityData, today = dayKey()): number {
  const dates = new Set(
    data.completions
      .filter((c) => !c.deletedAt)
      .map((c) => dayKey(new Date(c.completedAt))),
  );
  let day = dates.has(today) ? today : addDays(today, -1);
  let count = 0;
  while (dates.has(day)) {
    count++;
    day = addDays(day, -1);
  }
  return count;
}

export function formatClock(time: string, settings: Settings): string {
  if (!time) return '';
  return new Date(`2000-01-01T${time}:00`).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: settings.hour12 === 'system' ? undefined : settings.hour12 === '12',
  });
}
