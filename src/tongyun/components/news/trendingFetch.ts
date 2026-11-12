import { fetch as nativeFetch } from "@tauri-apps/plugin-http";
import { parseRSSXML } from "./rssParser";
import type { TrendingItem } from "./types";

const MAX_PER_CARD = 8;
const PRODUCT_HUNT_URL = "https://www.producthunt.com/feed";

type Transport = (url: string) => Promise<Response>;

/** Tauri's WebView fetch still enforces CORS; the HTTP plugin uses native transport. */
export async function fetchTrending(platform: string, tauri: boolean, transport: Transport = tauri ? nativeFetch : fetch): Promise<TrendingItem[]> {
  const url = platform === "producthunt" ? PRODUCT_HUNT_URL : `https://uapis.cn/api/v1/misc/hotboard?type=${encodeURIComponent(platform)}`;
  let response: Response;
  try {
    response = await transport(url);
  } catch (error) {
    if (tauri) throw new Error(`网络请求失败，请检查网络连接或稍后重试：${String(error)}`);
    try {
      response = await transport(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`);
    } catch (proxyError) {
      throw new Error(`浏览器直连及跨域代理均失败，请检查网络或使用桌面版后重试：${String(proxyError)}`);
    }
  }
  if (!response.ok) throw new Error(`上游请求失败：HTTP ${response.status}`);
  let raw: string;
  try { raw = await response.text(); } catch (error) {
    throw new Error(`读取上游响应失败，请检查网络后重试：${String(error)}`);
  }
  if (platform === "producthunt") {
    const doc = new DOMParser().parseFromString(raw, "text/xml");
    if (doc.querySelector("parsererror") || !["rss", "feed", "RDF"].includes(doc.documentElement.localName)) {
      throw new Error("Product Hunt 返回了无效的 RSS/Atom 数据");
    }
    const articles = parseRSSXML(raw);
    const items = validItems(articles.map((a) => ({ title: a.title, url: a.link })));
    if (doc.querySelector("item, entry") && !items.length) throw new Error("Product Hunt 数据缺少有效标题或链接");
    return items;
  }
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new Error("热榜接口返回了无效的 JSON"); }
  if (!json || typeof json !== "object" || !Array.isArray((json as { list?: unknown }).list)) {
    throw new Error("热榜接口响应缺少榜单数据");
  }
  const list = (json as { list: unknown[] }).list;
  const items = validItems(list);
  if (list.length && !items.length) throw new Error("热榜接口数据缺少有效标题或链接");
  return items;
}

function validItems(list: unknown[]): TrendingItem[] {
  return list.filter((item): item is TrendingItem => {
    if (!item || typeof item !== "object") return false;
    const { title, url } = item as TrendingItem;
    if (typeof title !== "string" || !title.trim() || typeof url !== "string") return false;
    try {
      const parsed = new URL(url);
      return (parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password;
    } catch { return false; }
  }).slice(0, MAX_PER_CARD);
}
