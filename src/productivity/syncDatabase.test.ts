import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { newTask, emptyData } from './model.ts';
import { mergeRecords } from './syncModel.ts';

test('deployed SQL enforces account isolation, conditional updates and cascade deletion', async () => {
  const db = await PGlite.create();
  try {
    await db.exec(`create schema auth; create role authenticated; create role anon;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth, public to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;
      insert into auth.users values ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');`);
    await db.exec(
      await readFile(
        new URL(
          '../../supabase/migrations/202609110001_productivity.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const userA = '00000000-0000-4000-8000-000000000001';
    const userB = '00000000-0000-4000-8000-000000000002';
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
      userA,
    ]);
    const task = newTask('A private task', 100);
    const merge = (row: unknown) =>
      db.query('select public.konh_merge_records($1::jsonb)', [
        JSON.stringify([{ kind: 'tasks', record_id: task.id, data: row }]),
      ]);
    await merge(task);
    await merge({ ...task, updatedAt: 200, deletedAt: 200 });
    await merge(task);
    assert.equal(
      (
        await db.query<{ data: { deletedAt: number } }>(
          'select data from konh_records',
        )
      ).rows[0].data.deletedAt,
      200,
    );
    const local = { ...task, updatedAt: 300, title: 'z', pinned: false };
    const remote = { ...task, updatedAt: 300, title: 'a', pinned: true };
    await merge(local);
    await merge(remote);
    const merged = emptyData();
    merged.tasks.push(local);
    mergeRecords(merged, [{ kind: 'tasks', record_id: task.id, data: remote }]);
    assert.deepEqual(
      (await db.query<{ data: unknown }>('select data from konh_records'))
        .rows[0].data,
      merged.tasks[0],
    );
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
      userB,
    ]);
    assert.equal((await db.query('select * from konh_records')).rows.length, 0);
    await assert.rejects(
      () =>
        db.query(
          'insert into konh_records(user_id,kind,record_id,data) values($1,$2,$3,$4)',
          [
            userA,
            'tasks',
            'hack',
            JSON.stringify({ id: 'hack', updatedAt: 1 }),
          ],
        ),
      /row-level security/,
    );
    await db.exec('reset role; set role anon');
    await assert.rejects(
      () => db.query('select * from konh_records'),
      /permission denied/,
    );
    await assert.rejects(() => merge(task), /permission denied/);
    await db.exec('reset role');
    await db.query('delete from auth.users where id=$1', [userA]);
    assert.equal((await db.query('select * from konh_records')).rows.length, 0);
  } finally {
    await db.close();
  }
});
