import { addDays, type Task } from './model.ts';
export function calendarPayload(task: Task) {
  const start = task.time ? new Date(`${task.due}T${task.time}:00`) : null;
  const end = start
    ? new Date(start.getTime() + Math.max(1, task.estimate || 30) * 60000)
    : null;
  return {
    summary: `${task.completedAt ? '✓ ' : ''}${task.title}`,
    description: task.notes,
    start: start ? { dateTime: start.toISOString() } : { date: task.due },
    end: end ? { dateTime: end.toISOString() } : { date: addDays(task.due, 1) },
    extendedProperties: { private: { source: 'konh', taskId: task.id } },
  };
}

export interface GoogleEvent {
  id: string;
  status?: string;
  extendedProperties?: { private?: { source?: string; taskId?: string } };
}
export interface GoogleResult {
  id?: string;
  status?: string;
  extendedProperties?: GoogleEvent['extendedProperties'];
  items?: GoogleEvent[];
  nextPageToken?: string;
}
export type GoogleRequest = (
  path: string,
  method?: string,
  body?: unknown,
) => Promise<GoogleResult | null>;
export interface CalendarOptions {
  calendarTimedOnly: boolean;
  calendarKeepCompleted: boolean;
}

export async function readGoogleResponse(
  response: Response,
  method: string,
): Promise<GoogleResult | null> {
  if (response.status === 204) return null;
  if (method === 'GET' && response.status === 410)
    return { status: 'cancelled' };
  if ((method === 'GET' || method === 'DELETE') && response.status === 404)
    return null;
  if (method === 'DELETE' && response.status === 410) return null;
  if (!response.ok) throw new Error(`Google 日历请求失败 (${response.status})`);
  return response.json();
}

export async function pushGoogleTasks(
  request: GoogleRequest,
  calendarId: string,
  tasks: Task[],
  options: CalendarOptions,
): Promise<void> {
  const base = `calendars/${encodeURIComponent(calendarId)}/events`;
  const existing = new Map<string, GoogleEvent>();
  let pageToken = '';
  const seenPages = new Set<string>();
  // Finish every page before mutating anything; a failed/incomplete list is not an empty calendar.
  do {
    if (seenPages.has(pageToken))
      throw new Error('Google 日历返回了重复分页标记');
    seenPages.add(pageToken);
    const result = await request(
      `${base}?maxResults=2500&privateExtendedProperty=source%3Dkonh${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
    );
    if (!result || (result.items !== undefined && !Array.isArray(result.items)))
      throw new Error('Google 日历列表读取失败');
    for (const event of result.items ?? []) {
      const taskId = event.extendedProperties?.private?.taskId;
      if (taskId && event.status !== 'cancelled') existing.set(taskId, event);
    }
    pageToken = result.nextPageToken ?? '';
  } while (pageToken);
  for (const task of tasks) {
    const remote = existing.get(task.id);
    existing.delete(task.id);
    const eligible =
      !task.deletedAt &&
      !!task.due &&
      (!options.calendarTimedOnly || !!task.time) &&
      (!task.completedAt || options.calendarKeepCompleted);
    if (!eligible) {
      if (remote)
        await request(`${base}/${encodeURIComponent(remote.id)}`, 'DELETE');
      continue;
    }
    const payload = calendarPayload(task);
    if (remote) {
      await request(`${base}/${encodeURIComponent(remote.id)}`, 'PUT', payload);
      continue;
    }
    const rootId = task.id
      .replace(/-/g, '')
      .toLowerCase()
      .replace(/[^a-v0-9]/g, '0');
    // Deleted Google events retain their IDs. Deterministic generations allow restoration
    // without reusing a tombstone, while every retry probes the same IDs on every device.
    let written = false;
    for (let generation = 0; generation < 100; generation++) {
      const id =
        generation === 0 ? rootId : `${rootId}g${generation.toString(16)}`;
      const known = await request(`${base}/${id}`);
      if (known?.status === 'cancelled') continue;
      if (known) {
        if (known.extendedProperties?.private?.taskId !== task.id)
          throw new Error('Google 日历事件 ID 已被其他数据占用');
        await request(`${base}/${id}`, 'PUT', payload);
      } else await request(base, 'POST', { ...payload, id });
      written = true;
      break;
    }
    if (!written)
      throw new Error('此任务的 Google 日历删除记录过多，请重新连接日历');
  }
  for (const remote of existing.values())
    await request(`${base}/${encodeURIComponent(remote.id)}`, 'DELETE');
}
