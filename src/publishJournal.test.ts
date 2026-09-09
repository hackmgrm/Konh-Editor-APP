import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublishJournal, type PublishAttempt, type PublishSnapshot } from './publishJournal.ts';

const snapshot: PublishSnapshot = {
  articleKey: 'workspace::article', accountId: 'wx-a', title: '标题', markdown: '正文', htmlHash: 'html', coverHash: 'cover',
  digest: '', author: '', sourceUrl: '', openComment: false, target: null,
};
const receipt = { mediaId: 'draft', updated: false };
function setup() {
  let records: PublishAttempt[] = [];
  const storage = { read: () => records, write: async (next: PublishAttempt[]) => { records = structuredClone(next); } };
  return { storage, journal: createPublishJournal(storage) };
}
const rejection = (error: unknown) => error === 'rejected';

test('先写盘再提交，完成后拒绝同版本重复提交', async () => {
  const { journal, storage } = setup();
  await journal.run(snapshot, async submit => {
    assert.equal(storage.read()[0].state, 'preparing');
    await submit('complete-assets-id');
    assert.equal(storage.read()[0].artifactId, 'complete-assets-id');
    assert.equal(storage.read()[0].state, 'submitting');
    return receipt;
  }, rejection);
  assert.equal(storage.read()[0].state, 'completed');
  await assert.rejects(journal.run(snapshot, async () => { assert.fail('不能重复调用'); }, rejection), /已推送成功/);
});

test('提交后断网跨重启阻止重试，即使正文已经改变；核对后可继续', async () => {
  const { journal, storage } = setup();
  await assert.rejects(journal.run(snapshot, async submit => { await submit(); throw new Error('timeout'); }, rejection), /待核对/);
  const restarted = createPublishJournal(storage);
  await assert.rejects(restarted.run({ ...snapshot, markdown: '新文' }, async () => receipt, rejection), /待核对/);
  await restarted.resolve(storage.read()[0].id);
  await restarted.run(snapshot, async submit => { await submit(); return receipt; }, rejection);
  assert.equal(storage.read()[0].state, 'completed');
});

test('准备阶段失败和微信明确拒绝都可以重试', async () => {
  for (const submitted of [false, true]) {
    const { journal, storage } = setup();
    await assert.rejects(journal.run(snapshot, async submit => { if (submitted) await submit(); throw 'rejected'; }, rejection));
    assert.equal(storage.read()[0].state, 'failed');
    await journal.run(snapshot, async submit => { await submit(); return receipt; }, rejection);
  }
});

test('日志落盘失败不发送草稿请求', async () => {
  const { storage } = setup();
  const journal = createPublishJournal({ ...storage, write: async next => {
    if (next[0].state === 'submitting') throw new Error('disk full');
    await storage.write(next);
  } });
  let requests = 0;
  await assert.rejects(journal.run(snapshot, async submit => { await submit(); requests++; return receipt; }, rejection), /disk full/);
  assert.equal(requests, 0);
});

test('成功响应后的日志失败仍保留待核对状态', async () => {
  const { storage } = setup();
  const journal = createPublishJournal({ ...storage, write: async next => {
    if (next[0].state === 'completed' || next[0].state === 'unknown') throw new Error('disk full');
    await storage.write(next);
  } });
  await assert.rejects(journal.run(snapshot, async submit => { await submit(); return receipt; }, rejection), /本地记录保存失败/);
  assert.equal(storage.read()[0].state, 'submitting');
  await assert.rejects(createPublishJournal(storage).run(snapshot, async () => receipt, rejection), /待核对/);
});

test('双击只执行一次且执行期间不可手动解除', async () => {
  const { journal, storage } = setup();
  let finish!: () => void;
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const first = journal.run(snapshot, async submit => { await submit(); ready(); await waiting; return receipt; }, rejection);
  await started;
  await assert.rejects(journal.run(snapshot, async () => receipt, rejection), /正在推送/);
  await assert.rejects(journal.resolve(storage.read()[0].id), /仍在进行/);
  finish();
  await first;
});

test('发布快照冻结且跨账户并发不会丢失记录', async () => {
  const { journal, storage } = setup();
  const source = { ...snapshot };
  const first = journal.run(source, async submit => { source.markdown = '已修改'; await submit(); return receipt; }, rejection);
  const second = journal.run({ ...snapshot, accountId: 'wx-b' }, async submit => { await submit(); return receipt; }, rejection);
  await Promise.all([first, second]);
  assert.equal(storage.read().length, 2);
  assert.ok(storage.read().every(item => item.state === 'completed' && item.snapshot.markdown === '正文'));
});
