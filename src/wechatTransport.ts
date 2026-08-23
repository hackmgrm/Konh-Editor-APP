/**
 * Transport layer for the WeChat API.
 *
 * The request goes out through the Rust http plugin rather than the WebView's
 * own fetch: nothing here is bound by the same-origin policy, so there is no
 * CORS to route around, and the AppSecret travels from this machine straight to
 * WeChat with no hop in between — no third party ever holds it.
 *
 * It also settles the allow-list problem. WeChat checks the egress IP of the
 * caller, and the egress here is the user's own connection: fill the allow-list
 * in the console once and it stays valid.
 *
 * Routes are named rather than spelled out as URLs (token / uploadimg /
 * material / draft / draftget / draftitem / draftupdate / probe / whoami), so
 * wechat.ts states what it wants and this file owns every endpoint, method and
 * body shape.
 */
import { fetch } from '@tauri-apps/plugin-http';

const API = 'https://api.weixin.qq.com';

export interface WxResponse {
  errcode?: number;
  errmsg?: string;
  [key: string]: unknown;
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const mime = dataUrl.slice(5, comma).split(';')[0] || 'image/jpeg';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** One of two image sources: a data URI from the body, or a remote address */
async function resolveImage(body: Record<string, any>): Promise<Blob> {
  if (typeof body.dataUrl === 'string' && body.dataUrl.startsWith('data:')) {
    return dataUrlToBlob(body.dataUrl);
  }
  if (typeof body.url === 'string' && body.url) {
    const res = await fetch(body.url, { headers: { Referer: new URL(body.url).origin } });
    if (!res.ok) throw new Error(`拉取图片失败（HTTP ${res.status}）`);
    return await res.blob();
  }
  throw new Error('缺少图片内容');
}

/** WeChat decides image type from the file extension; no extension is an error */
function withExtension(name: string, mime: string): string {
  if (/\.(jpe?g|png)$/i.test(name)) return name;
  return `${name.replace(/\.[^.]*$/, '') || 'image'}.${mime.includes('png') ? 'png' : 'jpg'}`;
}

async function postJson(url: string, payload: unknown): Promise<WxResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return (await res.json()) as WxResponse;
}

async function postForm(url: string, blob: Blob, filename: string): Promise<WxResponse> {
  const form = new FormData();
  form.append('media', blob, withExtension(filename, blob.type));
  const res = await fetch(url, { method: 'POST', body: form });
  return (await res.json()) as WxResponse;
}

const token = (t: unknown) => encodeURIComponent(String(t ?? ''));

/** Every WeChat endpoint this app touches, in one switch */
export async function callWechat(route: string, body: Record<string, any>): Promise<WxResponse> {
  switch (route) {
    case 'token': {
      if (!body.appid || !body.secret) return { errcode: -1, errmsg: '缺少 AppID / AppSecret' };
      return postJson(`${API}/cgi-bin/stable_token`, {
        grant_type: 'client_credential',
        appid: body.appid,
        secret: body.secret,
      });
    }
    case 'uploadimg': {
      // Body images must go through this endpoint: a body referencing an
      // add_material address gets re-fetched, transcoded and downscaled by WeChat
      const blob = await resolveImage(body);
      return postForm(
        `${API}/cgi-bin/media/uploadimg?access_token=${token(body.access_token)}`,
        blob,
        body.filename ?? 'image.jpg',
      );
    }
    case 'material': {
      const blob = await resolveImage(body);
      return postForm(
        `${API}/cgi-bin/material/add_material?access_token=${token(body.access_token)}&type=image`,
        blob,
        body.filename ?? 'cover.jpg',
      );
    }
    case 'draft': {
      if (!Array.isArray(body.articles)) return { errcode: -1, errmsg: '缺少 articles' };
      return postJson(`${API}/cgi-bin/draft/add?access_token=${token(body.access_token)}`, {
        articles: body.articles,
      });
    }
    case 'draftget': {
      // The drafts box, a page at a time. no_content=1 is the listing case —
      // the bodies are the bulk of the response and the list shows none of them
      return postJson(`${API}/cgi-bin/draft/batchget?access_token=${token(body.access_token)}`, {
        offset: body.offset ?? 0,
        count: body.count ?? 1,
        no_content: body.no_content ?? 0,
      });
    }
    case 'draftitem': {
      // One draft by media_id, bodies included
      return postJson(`${API}/cgi-bin/draft/get?access_token=${token(body.access_token)}`, {
        media_id: body.media_id,
      });
    }
    case 'draftupdate': {
      // Overwrite one article inside an existing draft. `index` addresses the
      // article within the draft, and `articles` is a single object here, not
      // an array — draft/add and draft/update disagree on that shape
      return postJson(`${API}/cgi-bin/draft/update?access_token=${token(body.access_token)}`, {
        media_id: body.media_id,
        index: body.index ?? 0,
        articles: body.articles,
      });
    }
    case 'probe': {
      // A read-only probe, aimed at the drafts endpoints themselves (same group
      // as pushing a draft, or the verdict would not mean anything)
      const res = await fetch(`${API}/cgi-bin/draft/count?access_token=${token(body.access_token)}`);
      return (await res.json()) as WxResponse;
    }
    case 'whoami': {
      // The desktop version's egress is this machine's own connection, so the IP
      // is stable and safe to put on the allow-list
      const res = await fetch('https://api.ipify.org?format=json');
      const data = (await res.json()) as { ip?: string };
      return { ip: data.ip ?? '', stable: true };
    }
    default:
      return { errcode: -1, errmsg: `未知路由 ${route}` };
  }
}
