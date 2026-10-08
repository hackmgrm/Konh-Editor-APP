import type { CalendarEvent, ProductivityData } from './model.ts';
import { addDays } from './model.ts';
export interface TimeBlock {
  id: string;
  kind: 'task' | 'event';
  title: string;
  start: number;
  end: number;
  lane: number;
  lanes: number;
}
export function eventOnDay(event: CalendarEvent, day: string): boolean {
  return (
    !event.deletedAt &&
    (event.allDay
      ? event.start.slice(0, 10) <= day && event.end.slice(0, 10) >= day
      : event.start < `${addDays(day, 1)}T00:00` && event.end > `${day}T00:00`)
  );
}
const minute = (value: string) =>
  Number(value.slice(11, 13)) * 60 + Number(value.slice(14, 16));
export function dayBlocks(data: ProductivityData, day: string): TimeBlock[] {
  const blocks: TimeBlock[] = [];
  for (const task of data.tasks)
    if (!task.deletedAt && !task.completedAt && task.due === day && task.time) {
      const start = minute(`${day}T${task.time}`);
      blocks.push({
        id: task.id,
        kind: 'task',
        title: task.title,
        start,
        end: Math.min(1440, start + (task.estimate || 30)),
        lane: 0,
        lanes: 1,
      });
    }
  for (const event of data.events)
    if (!event.allDay && eventOnDay(event, day))
      blocks.push({
        id: event.id,
        kind: 'event',
        title: event.title,
        start: event.start.slice(0, 10) < day ? 0 : minute(event.start),
        end: event.end.slice(0, 10) > day ? 1440 : minute(event.end),
        lane: 0,
        lanes: 1,
      });
  blocks.sort((a, b) => a.start - b.start || b.end - a.end);
  let group: TimeBlock[] = [];
  let groupEnd = 0;
  let lanes: number[] = [];
  const finish = () =>
    group.forEach((block) => {
      block.lanes = lanes.length;
    });
  for (const block of blocks) {
    if (block.start >= groupEnd) {
      finish();
      group = [];
      lanes = [];
    }
    let lane = lanes.findIndex((end) => end <= block.start);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = block.end;
    block.lane = lane;
    group.push(block);
    groupEnd = Math.max(...lanes);
  }
  finish();
  return blocks;
}
