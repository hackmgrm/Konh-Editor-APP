import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addQuickTask,
  completeTask,
  dayKey,
  elapsed,
  emptyData,
  estimateMinutes,
  newTask,
  nextDue,
  parseQuickAdd,
  startTimer,
  stopTimer,
  toggleTimer,
  visibleTasks,
  dailySummary,
  streakDays,
} from './model.ts';

test('Chinese quick add extracts time, priority, labels and recurrence without swallowing title', () => {
  const p = parseQuickAdd(
    '明天下午3点 预约牙医 #生活 p2',
    new Date('2026-09-11T10:00:00'),
  );
  assert.deepEqual(p, {
    title: '预约牙医',
    due: '2026-09-12',
    time: '15:00',
    priority: 2,
    labels: ['生活'],
    repeat: 'none',
  });
  const d = emptyData();
  addQuickTask(d, '每天 喝水 #健康 p1');
  assert.equal(d.tasks[0].repeat, 'daily');
  assert.equal(d.labels.length, 1);
  assert.equal(d.tasks[0].labels[0], d.labels[0].id);
});
test('English natural dates parse and retain remaining title', () => {
  const p = parseQuickAdd(
    'pay rent friday 5pm #home p1',
    new Date('2026-09-10T10:00:00'),
  );
  assert.equal(p.title, 'pay rent');
  assert.equal(p.due, '2026-09-11');
  assert.equal(p.time, '17:00');
});
test('recurrence skips overdue dates and clamps month/leap boundaries', () => {
  assert.equal(nextDue('2026-09-11', 'weekdays', '2026-09-11'), '2026-09-14');
  assert.equal(nextDue('2026-01-31', 'monthly', '2026-01-31'), '2026-02-28');
  assert.equal(nextDue('2024-02-29', 'yearly', '2024-02-29'), '2025-02-28');
  assert.equal(nextDue('2026-09-01', 'weekly', '2026-09-11'), '2026-09-15');
});
test('repeat completion preserves history and resets checklist/reminder', () => {
  const d = emptyData();
  const t = newTask('健身');
  t.due = '2026-09-11';
  t.repeat = 'weekly';
  t.time = '16:00';
  t.subtasks = [{ id: 's', title: '拉伸', done: true }];
  d.tasks.push(t);
  completeTask(d, t.id, new Date('2026-09-11T17:00:00').getTime());
  assert.equal(t.due, '2026-09-18');
  assert.equal(t.completedAt, null);
  assert.equal(t.subtasks[0].done, false);
  assert.equal(d.completions.length, 1);
  assert.ok(t.reminderAt);
});
test('smart views handle overdue, deleted, completed and pin order', () => {
  const d = emptyData();
  const overdue = newTask('old');
  overdue.due = '2026-09-10';
  const today = newTask('today');
  today.due = '2026-09-11';
  today.pinned = true;
  const future = newTask('future');
  future.due = '2026-09-12';
  const inbox = newTask('inbox');
  const deleted = newTask('gone');
  deleted.deletedAt = 1;
  d.tasks.push(overdue, today, future, inbox, deleted);
  assert.deepEqual(
    visibleTasks(d, 'today', '', 0, '', '2026-09-11').map((t) => t.title),
    ['today', 'old'],
  );
  assert.deepEqual(
    visibleTasks(d, 'inbox').map((t) => t.title),
    ['inbox'],
  );
  completeTask(d, inbox.id);
  assert.equal(visibleTasks(d, 'completed')[0].title, 'inbox');
});
test('timer persists wall clock, excludes pauses and separates rest from work', () => {
  const d = emptyData();
  startTimer(d, 'focus', null, 1000);
  assert.equal(elapsed(d.timer, 11000), 10);
  toggleTimer(d, 11000);
  assert.equal(elapsed(d.timer, 61000), 10);
  toggleTimer(d, 61000);
  stopTimer(d, 71000);
  assert.equal(d.sessions[0].seconds, 20);
  startTimer(d, 'shortBreak', null, 72000);
  stopTimer(d, 172000);
  assert.equal(d.sessions.length, 1);
  startTimer(d, 'stopwatch', null, 200000);
  const restored = JSON.parse(JSON.stringify(d));
  assert.equal(elapsed(restored.timer, 260000), 60);
});
test('estimates and summary use concrete completed sessions', () => {
  assert.equal(estimateMinutes('1h30'), 90);
  assert.equal(estimateMinutes('1.5h'), 90);
  assert.equal(estimateMinutes('90'), 90);
  const d = emptyData();
  d.tasks.push(newTask('写日记'));
  completeTask(d, d.tasks[0].id);
  assert.match(dailySummary(d, dayKey()), /写日记/);
  assert.equal(streakDays(d), 1);
});

test('monthly repeats preserve original day after February and Chinese day-after-tomorrow remains intact', () => {
  const d = emptyData();
  const task = newTask('月末整理');
  task.due = '2026-01-31';
  task.repeat = 'monthly';
  d.tasks.push(task);
  completeTask(d, task.id, new Date('2026-01-31T12:00:00').getTime());
  assert.equal(task.due, '2026-02-28');
  completeTask(d, task.id, new Date('2026-02-28T12:00:00').getTime());
  assert.equal(task.due, '2026-03-31');
  const p = parseQuickAdd('大后天 洗衣服', new Date('2026-09-11T10:00:00'));
  assert.equal(p.due, '2026-09-14');
  assert.equal(p.title, '洗衣服');
});
