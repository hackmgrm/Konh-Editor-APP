import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTask } from './model.ts';
import {
  pushGoogleTasks,
  readGoogleResponse,
  type GoogleEvent,
  type GoogleRequest,
} from './googleCalendar.ts';
function calendar() {
  const events = new Map<string, GoogleEvent>();
  const bodies = new Map<string, unknown>();
  const calls: { method: string; path: string }[] = [];
  let failAfterCreate = false;
  const request: GoogleRequest = async (path, method = 'GET', body) => {
    calls.push({ method, path });
    if (path.includes('?'))
      return {
        items: [...events.values()].filter((e) => e.status !== 'cancelled'),
      };
    const id = path.split('/').pop()!;
    if (method === 'GET') return events.get(id) ?? null;
    if (method === 'DELETE') {
      events.set(id, { id, status: 'cancelled' });
      return null;
    }
    const payload = body as GoogleEvent;
    const target = method === 'POST' ? payload.id : id;
    if (method === 'POST' && events.has(target))
      throw new Error('409 conflict');
    events.set(target, { ...payload, id: target });
    bodies.set(target, body);
    if (method === 'POST' && failAfterCreate) {
      failAfterCreate = false;
      throw new Error('response lost');
    }
    return { id: target };
  };
  return {
    events,
    bodies,
    calls,
    request,
    loseNextResponse: () => {
      failAfterCreate = true;
    },
  };
}
const options = { calendarTimedOnly: false, calendarKeepCompleted: false };
test('completed-event deletion can be reversed by keep-completed without reusing a tombstone', async () => {
  const c = calendar();
  const task = newTask('Keep me');
  task.due = '2026-09-11';
  await pushGoogleTasks(c.request, 'cal', [task], options);
  task.completedAt = 1;
  await pushGoogleTasks(c.request, 'cal', [task], options);
  assert.equal(
    [...c.events.values()].filter((e) => e.status !== 'cancelled').length,
    0,
  );
  await pushGoogleTasks(c.request, 'cal', [task], {
    ...options,
    calendarKeepCompleted: true,
  });
  const restored = [...c.events.values()].filter(
    (e) => e.status !== 'cancelled',
  );
  assert.equal(restored.length, 1);
  assert.match(restored[0].id, /g1$/);
});
test('a lost create response is reconciled without duplicate events; recurrence updates in place', async () => {
  const c = calendar();
  const task = newTask('Recurring');
  task.due = '2026-09-11';
  c.loseNextResponse();
  await assert.rejects(
    pushGoogleTasks(c.request, 'cal', [task], options),
    /response lost/,
  );
  await pushGoogleTasks(c.request, 'cal', [task], options);
  task.due = '2026-09-18';
  await pushGoogleTasks(c.request, 'cal', [task], options);
  assert.equal(c.events.size, 1);
  assert.equal(c.calls.filter((c) => c.method === 'POST').length, 1);
  const body = [...c.bodies.values()][0] as { start: { date: string } };
  assert.equal(body.start.date, '2026-09-18');
});
test('an incomplete paginated read never starts mutating calendar events', async () => {
  const writes: string[] = [];
  const request: GoogleRequest = async (path, method = 'GET') => {
    if (method !== 'GET') writes.push(method);
    if (path.includes('pageToken')) throw new Error('offline');
    return {
      items: [
        {
          id: 'remote',
          extendedProperties: { private: { taskId: 'missing' } },
        },
      ],
      nextPageToken: 'next',
    };
  };
  await assert.rejects(pushGoogleTasks(request, 'cal', [], options), /offline/);
  assert.deepEqual(writes, []);
});
test('failed writes cannot masquerade as successful missing-resource reads', async () => {
  await assert.rejects(
    readGoogleResponse(new Response(null, { status: 404 }), 'PUT'),
    /404/,
  );
  await assert.rejects(
    readGoogleResponse(new Response(null, { status: 410 }), 'POST'),
    /410/,
  );
  assert.deepEqual(
    await readGoogleResponse(new Response(null, { status: 410 }), 'GET'),
    { status: 'cancelled' },
  );
  assert.equal(
    await readGoogleResponse(new Response(null, { status: 410 }), 'DELETE'),
    null,
  );
});
