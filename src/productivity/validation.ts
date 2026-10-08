import type { ProductivityData } from './model.ts';
import type { SyncKind } from './syncModel.ts';
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const number = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value);
export function validDay(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T12:00:00`);
  return (
    Number.isFinite(date.getTime()) &&
    date.getFullYear() === Number(value.slice(0, 4)) &&
    date.getMonth() + 1 === Number(value.slice(5, 7)) &&
    date.getDate() === Number(value.slice(8, 10))
  );
}
export function validateRecord(kind: SyncKind | 'events', row: unknown): void {
  if (
    !object(row) ||
    typeof row.id !== 'string' ||
    !row.id ||
    !number(row.updatedAt)
  )
    throw new Error('记录缺少有效的身份或修改时间');
  if (row.deletedAt !== undefined && !number(row.deletedAt))
    throw new Error('删除记录格式无效');
  const text = (...keys: string[]) =>
    keys.every((key) => typeof row[key] === 'string');
  let valid = false;
  switch (kind) {
    case 'tasks':
      valid =
        text('title', 'notes', 'due', 'time') &&
        (row.due === '' || validDay(row.due)) &&
        (row.time === '' ||
          /^([01]\d|2[0-3]):[0-5]\d$/.test(row.time as string)) &&
        [1, 2, 3, 4].includes(row.priority as number) &&
        ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'yearly'].includes(
          row.repeat as string,
        ) &&
        number(row.order) &&
        number(row.estimate) &&
        (row.estimate as number) >= 0 &&
        typeof row.pinned === 'boolean' &&
        number(row.createdAt) &&
        (row.completedAt === null || number(row.completedAt)) &&
        Array.isArray(row.labels) &&
        row.labels.every((id) => typeof id === 'string') &&
        Array.isArray(row.subtasks) &&
        row.subtasks.every(
          (s) =>
            object(s) &&
            typeof s.id === 'string' &&
            typeof s.title === 'string' &&
            typeof s.done === 'boolean',
        );
      break;
    case 'labels':
      valid =
        text('name', 'color') && /^#[0-9a-f]{6}$/i.test(row.color as string);
      break;
    case 'journals':
      valid =
        text('title', 'body') &&
        validDay(row.date) &&
        [1, 2, 3, 4, 5].includes(row.mood as number);
      break;
    case 'sessions':
      valid =
        text('taskTitle') &&
        number(row.startedAt) &&
        number(row.endedAt) &&
        number(row.seconds) &&
        (row.seconds as number) >= 0 &&
        ['focus', 'stopwatch'].includes(row.kind as string);
      break;
    case 'completions':
      valid = text('title', 'taskId') && number(row.completedAt);
      break;
    case 'events':
      valid =
        text('title', 'notes', 'start', 'end') &&
        validDay((row.start as string).slice(0, 10)) &&
        validDay((row.end as string).slice(0, 10)) &&
        typeof row.allDay === 'boolean';
      break;
  }
  if (!valid) throw new Error(`${kind} 数据格式无效，已停止载入以保护本机数据`);
}
export function validateData(
  value: unknown,
): asserts value is ProductivityData {
  if (!object(value) || value.schema !== 1 || !object(value.settings))
    throw new Error('无法识别效率数据版本');
  for (const kind of [
    'tasks',
    'labels',
    'journals',
    'sessions',
    'completions',
    'events',
  ] as const) {
    const rows = value[kind];
    if (!Array.isArray(rows)) throw new Error(`缺少 ${kind} 集合`);
    const ids = new Set();
    for (const row of rows) {
      validateRecord(kind, row);
      if (ids.has(row.id)) throw new Error('存在重复记录');
      ids.add(row.id);
    }
  }
}
