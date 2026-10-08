import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyData, newTask } from './model.ts';
import { copyForAccount, mergeRecords, records } from './syncModel.ts';
import { calendarPayload } from './googleCalendar.ts';

test('sync merges independent records and tombstones without resurrecting deletes', () => {
  const d = emptyData();
  const a = newTask('A', 10);
  d.tasks.push(a);
  const deleted = { ...a, deletedAt: 20, updatedAt: 20 };
  mergeRecords(d, [{ kind: 'tasks', record_id: a.id, data: deleted }]);
  mergeRecords(d, [{ kind: 'tasks', record_id: a.id, data: a }]);
  assert.equal(d.tasks[0].deletedAt, 20);
  const other = newTask('B', 30);
  mergeRecords(d, [{ kind: 'tasks', record_id: other.id, data: other }]);
  assert.equal(d.tasks.length, 2);
});
test('same-time merge is deterministic independent of delivery order', () => {
  const a = newTask('a', 10);
  const b = { ...a, title: 'b' };
  const x = emptyData();
  const y = emptyData();
  x.tasks.push(a);
  y.tasks.push(b);
  mergeRecords(x, records(y));
  mergeRecords(y, records(x));
  assert.deepEqual(x.tasks, y.tasks);
});
test('account copy regenerates IDs and references; independent calendar is not synced', () => {
  const d = emptyData();
  const task = newTask('Task');
  task.labels = ['label'];
  d.tasks.push(task);
  d.labels.push({ id: 'label', name: 'Life', color: '#000000', updatedAt: 1 });
  d.sessions.push({
    id: 'session',
    taskId: task.id,
    taskTitle: 'Task',
    startedAt: 1,
    endedAt: 2,
    seconds: 1,
    kind: 'focus',
    updatedAt: 1,
  });
  d.events.push({
    id: 'event',
    title: 'Local',
    notes: '',
    start: '2026-09-11T09:00',
    end: '2026-09-11T10:00',
    allDay: false,
    updatedAt: 1,
  });
  const oldId = task.id;
  copyForAccount(d);
  assert.notEqual(d.tasks[0].id, oldId);
  assert.equal(d.tasks[0].labels[0], d.labels[0].id);
  assert.equal(d.sessions[0].taskId, d.tasks[0].id);
  assert.equal(d.events[0].id, 'event');
  assert.equal(
    records(d).some((r) => r.record_id === 'event'),
    false,
  );
});
test('Google date-only tasks have exclusive next-day end; timed tasks preserve actual instant', () => {
  const task = newTask('Meeting');
  task.due = '2026-12-31';
  const allDay = calendarPayload(task);
  assert.deepEqual(allDay.end, { date: '2027-01-01' });
  task.time = '23:30';
  task.estimate = 90;
  const timed = calendarPayload(task);
  assert.equal(
    new Date(timed.end.dateTime!).getTime() -
      new Date(timed.start.dateTime!).getTime(),
    90 * 60000,
  );
  assert.equal(timed.extendedProperties.private.taskId, task.id);
});
