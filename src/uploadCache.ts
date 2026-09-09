/** Account ownership is part of every material cache key. Legacy unscoped
 * entries intentionally miss: their owning account cannot be recovered. */
export async function uploadCacheKey(appid: string, source: string, policy: number, kind: 'body' | 'cover'): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([appid.trim(), policy, kind, source]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('');
}
