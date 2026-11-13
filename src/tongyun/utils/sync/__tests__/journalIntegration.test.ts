import { beforeEach, afterEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { WebDAVProvider } from "../webdavProvider";
import { getLocalSyncData } from "../types";
import { getFingerprint, setFingerprint } from "../conflict";

const config = { url: "https://dav.example/", username: "user" };
const account = `${config.url}|${config.username}`;
const entry = (id: string, updatedAt = 1) => ({ id, date: "2026-01-01", title: id, content: id, isDaily: false, createdAt: 1, updatedAt });
let files: Map<string, string>;
let uploads: string[];
let failJournal = false;
const path = (name: string) => `TongYunPlanner/${name}`;

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, String(v)), removeItem: (k: string) => values.delete(k) });
  vi.stubGlobal("window", { isTauri: true, __TAURI_INTERNALS__: {} });
  files = new Map(); uploads = []; failJournal = false;
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    const a = args as Record<string, string>;
    const name = a?.filename;
    if (cmd === "webdav_mkcol") return null;
    if (cmd === "webdav_stat") return { exists: files.has(name), etag: files.has(name) ? 'new' : null, lastModified: null };
    if (cmd === "webdav_download_meta") {
      if ((failJournal && name === path("journal.json")) || !files.has(name)) throw new Error("E_NOT_FOUND: missing");
      return { content: files.get(name), etag: 'new', lastModified: null };
    }
    if (cmd === "webdav_upload_meta") { uploads.push(name); files.set(name, a.content); return { exists: true, etag: 'new', lastModified: null }; }
    return null;
  });
});
afterEach(() => vi.unstubAllGlobals());
function setup(local: unknown[], remote: unknown[], localVersion = 1, remoteVersion = 2) {
  localStorage.setItem("tongyun_journal", JSON.stringify(local));
  localStorage.setItem("tongyun_cat_ver_journal", String(localVersion));
  files.set(path("journal.json"), JSON.stringify(remote));
  files.set(path("manifest.json"), JSON.stringify({ journal: { version: remoteVersion } }));
  setFingerprint(account, "journal.json", "etag:old");
}

it("acknowledges timestamp-only drift without uploading", async () => {
  setup([entry('a', 3)], [entry('a', 4)]);
  const result = await new WebDAVProvider(config).push(getLocalSyncData(), new Set(['journal']));
  expect(result.conflicts).toHaveLength(0);
  expect(uploads).toEqual([]);
  expect(getFingerprint(account, 'journal.json')).toBe('etag:new');
});
it("writes the union back to cloud after pulling local-only entries", async () => {
  setup([entry('local')], [entry('remote')]);
  await new WebDAVProvider(config).pull();
  expect(JSON.parse(files.get(path('journal.json'))!).map((e: {id:string}) => e.id).sort()).toEqual(['local', 'remote']);
  expect(JSON.parse(localStorage.getItem('tongyun_journal')!).map((e: {id:string}) => e.id).sort()).toEqual(['local', 'remote']);
});
it("fails closed when a manifest journal cannot be downloaded", async () => {
  setup([entry('local')], [entry('remote')]); failJournal = true;
  await expect(new WebDAVProvider(config).pull()).rejects.toThrow(/E_NOT_FOUND/);
  expect(uploads).toEqual([]);
  expect(JSON.parse(localStorage.getItem('tongyun_journal')!)).toEqual([entry('local')]);
});
it("restores an entry deleted from the remote snapshot", async () => {
  setup([entry('a'), entry('b')], [entry('a')]);
  await new WebDAVProvider(config).pull();
  expect(JSON.parse(files.get(path('journal.json'))!).map((e: {id:string}) => e.id).sort()).toEqual(['a', 'b']);
});
