import { validateRecord } from './validation.ts';
import { uid, type ProductivityData, type RecordBase } from './model.ts';
export const syncedKinds = [
  'tasks',
  'labels',
  'journals',
  'sessions',
  'completions',
] as const;
export type SyncKind = (typeof syncedKinds)[number];
export interface CloudRecord {
  kind: SyncKind;
  record_id: string;
  data: RecordBase;
}
export function records(data: ProductivityData): CloudRecord[] {
  return syncedKinds.flatMap((kind) =>
    data[kind].map((row) => ({ kind, record_id: row.id, data: row })),
  );
}
function compareUtf8(a: string, b: string): number {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++)
    if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => compareUtf8(a, b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function mergeRecords(
  data: ProductivityData,
  incoming: CloudRecord[],
): void {
  for (const record of incoming) {
    validateRecord(record.kind, record.data);
    if (
      !syncedKinds.includes(record.kind) ||
      record.data.id !== record.record_id ||
      !Number.isFinite(record.data.updatedAt)
    )
      throw new Error('云端记录格式无效');
    const collection = data[record.kind] as RecordBase[];
    const index = collection.findIndex((row) => row.id === record.record_id);
    if (index < 0) collection.push(structuredClone(record.data));
    else {
      const local = collection[index];
      const remote = record.data;
      if (
        remote.updatedAt > local.updatedAt ||
        (remote.updatedAt === local.updatedAt &&
          compareUtf8(canonical(remote), canonical(local)) > 0)
      )
        collection[index] = structuredClone(remote);
    }
  }
}
export function copyForAccount(data: ProductivityData): void {
  const ids = new Map<string, string>();
  for (const kind of syncedKinds)
    for (const row of data[kind]) ids.set(row.id, uid());
  const now = Date.now();
  for (const kind of syncedKinds) {
    const rows = data[kind] as RecordBase[];
    rows.splice(
      0,
      rows.length,
      ...rows
        .filter((r) => !r.deletedAt)
        .map((row) => ({ ...row, id: ids.get(row.id)!, updatedAt: now })),
    );
  }
  data.tasks.forEach((t) => {
    t.labels = t.labels.map((id) => ids.get(id) ?? id);
    t.subtasks.forEach((s) => {
      s.id = uid();
    });
  });
  data.sessions.forEach((s) => {
    s.taskId = s.taskId ? (ids.get(s.taskId) ?? null) : null;
  });
  data.completions.forEach((c) => {
    c.taskId = ids.get(c.taskId) ?? c.taskId;
  });
  if (data.timer?.taskId)
    data.timer.taskId = ids.get(data.timer.taskId) ?? null;
}
