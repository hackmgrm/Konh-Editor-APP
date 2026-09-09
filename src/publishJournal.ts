export interface PublishSnapshot {
  articleKey: string;
  accountId: string;
  title: string;
  markdown: string;
  htmlHash: string;
  coverHash: string;
  digest: string;
  author: string;
  sourceUrl: string;
  openComment: boolean;
  target: { mediaId: string; index: number; thumbMediaId: string } | null;
}

export interface PublishReceipt {
  mediaId: string;
  updated: boolean;
}

export interface PublishAttempt {
  id: string;
  fingerprint: string;
  snapshot: PublishSnapshot;
  state: 'preparing' | 'submitting' | 'completed' | 'failed' | 'unknown' | 'resolved';
  createdAt: number;
  updatedAt: number;
  message: string;
  receipt?: PublishReceipt;
  artifactId?: string;
}

export async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('');
}

export function needsPublishReview(attempt: PublishAttempt): boolean {
  return attempt.state === 'submitting' || attempt.state === 'unknown';
}

/** Dependencies keep the transaction rules testable without sending to WeChat.
 * The submitting record must reach disk before the request leaves this process. */
export function createPublishJournal(storage: {
  read: () => PublishAttempt[];
  write: (attempts: PublishAttempt[]) => Promise<void>;
}) {
  const active = new Set<string>();
  let writes: Promise<void> = Promise.resolve();
  function save(attempt: PublishAttempt): Promise<void> {
    const next = writes.then(async () => {
      const others = storage.read().filter(item => item.id !== attempt.id);
      // Unresolved operations must survive history retention.
      const retained = others.filter(needsPublishReview);
      const recent = others.filter(item => !needsPublishReview(item)).slice(0, 49);
      await storage.write([attempt, ...retained, ...recent]);
    });
    writes = next.catch(() => {});
    return next;
  }
  return {
    async resolve(id: string) {
      const attempt = storage.read().find(item => item.id === id);
      if (!attempt || !needsPublishReview(attempt)) return;
      const key = JSON.stringify([attempt.snapshot.articleKey, attempt.snapshot.accountId]);
      if (active.has(key)) throw new Error('发布仍在进行，请等待结果');
      await save({ ...attempt, state: 'resolved', message: '已由用户核对草稿箱', updatedAt: Date.now() });
    },
    async run<T extends PublishReceipt>(
      input: PublishSnapshot,
      perform: (beforeSubmit: (artifactId?: string) => Promise<void>) => Promise<T>,
      definiteRejection: (error: unknown) => boolean,
    ): Promise<T> {
      const snapshot = structuredClone(input);
      const key = JSON.stringify([snapshot.articleKey, snapshot.accountId]);
      if (active.has(key)) throw new Error('这篇文章正在推送，请等待结果');
      active.add(key);
      try {
        const fingerprint = await contentHash(JSON.stringify(snapshot));
        const previous = storage.read().filter(item => item.snapshot.articleKey === snapshot.articleKey && item.snapshot.accountId === snapshot.accountId);
        if (previous.some(needsPublishReview)) throw new Error('上次提交结果待核对，请先查看草稿箱并确认结果，再继续推送');
        if (previous[0]?.state === 'completed' && previous[0].fingerprint === fingerprint) throw new Error('这个版本已推送成功，无需重复提交；可到草稿箱查看');
        let attempt: PublishAttempt = {
          id: crypto.randomUUID(), fingerprint, snapshot, state: 'preparing',
          createdAt: Date.now(), updatedAt: Date.now(), message: '准备正文与图片',
        };
        await save(attempt);
        let submitted = false;
        let receipt: T | undefined;
        try {
          receipt = await perform(async (artifactId) => {
            const next = { ...attempt, artifactId, state: 'submitting' as const, updatedAt: Date.now(), message: '已进入草稿提交阶段' };
            await save(next);
            attempt = next;
            submitted = true;
          });
          attempt = { ...attempt, state: 'completed', receipt: { mediaId: receipt.mediaId, updated: receipt.updated }, updatedAt: Date.now(), message: '草稿推送成功' };
          await save(attempt);
          return receipt;
        } catch (error) {
          const uncertain = submitted && (receipt !== undefined || !definiteRejection(error));
          const message = receipt
            ? `微信已返回草稿编号 ${receipt.mediaId}，但本地记录保存失败，请先核对草稿箱`
            : uncertain ? '请求已提交，结果待核对。请先查看草稿箱，避免重复创建。' : error instanceof Error ? error.message : '准备失败，可重试';
          try {
            await save({ ...attempt, state: uncertain ? 'unknown' : 'failed', message, updatedAt: Date.now() });
          } catch {
            // The earlier durable submitting record continues to block retries.
          }
          if (uncertain) throw new Error(message);
          throw error;
        }
      } finally {
        active.delete(key);
      }
    },
  };
}
