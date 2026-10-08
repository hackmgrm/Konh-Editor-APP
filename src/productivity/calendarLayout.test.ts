import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyData } from './model.ts';
import { dayBlocks, eventOnDay } from './calendarLayout.ts';
test('overlapping events occupy separate columns and midnight end does not leak into the next day', () => {
  const data = emptyData();
  for (const [id, start, end] of [
    ['a', '09:00', '10:00'],
    ['b', '09:30', '10:30'],
    ['c', '11:00', '12:00'],
  ])
    data.events.push({
      id,
      title: id,
      notes: '',
      start: `2026-09-11T${start}`,
      end: `2026-09-11T${end}`,
      allDay: false,
      updatedAt: 1,
    });
  const blocks = dayBlocks(data, '2026-09-11');
  assert.deepEqual(
    blocks.map((b) => [b.lane, b.lanes]),
    [
      [0, 2],
      [1, 2],
      [0, 1],
    ],
  );
  const overnight = {
    ...data.events[0],
    start: '2026-09-11T23:00',
    end: '2026-09-12T00:00',
  };
  assert.equal(eventOnDay(overnight, '2026-09-12'), false);
  data.events = [overnight];
  assert.equal(dayBlocks(data, '2026-09-11')[0].end, 1440);
});
