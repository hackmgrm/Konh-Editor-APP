import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSchema, setDatabaseOverrideForTesting } from "./domainDatabase";
import { journalRepository } from "./repositories";
import { getFingerprint, setFingerprint } from "../utils/sync/conflict";

vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: async () => adapter(db) } }));
vi.mock("./domainDatabase", async (importOriginal) => {
  const original = await importOriginal<typeof import('./domainDatabase')>();
  return { ...original, initializeDomainDatabase: async () => {} };
});

let dir: string;
let db: DatabaseSync;
function adapter(sqlite: DatabaseSync) {
  return {
    execute: async (sql: string, values: unknown[] = []) => sqlite.prepare(sql.replace(/\$(\d+)/g, '?$1')).run(...values as any[]),
    select: async (sql: string, values: unknown[] = []) => sqlite.prepare(sql.replace(/\$(\d+)/g, '?$1')).all(...values as any[]),
  };
}
afterEach(() => { setDatabaseOverrideForTesting(null); db?.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); });
it("persists snapshot removals in the real journal tables", async () => {
  dir = mkdtempSync(join(tmpdir(), "konh-sqlite-"));
  db = new DatabaseSync(join(dir, "journal.db"));
  const api = adapter(db);
  await createSchema(api as never);
  setDatabaseOverrideForTesting(api as never);
  const a = { id: "a", linkKey: "a", date: "2026-01-01", title: "A", content: "A", isDaily: false, createdAt: 1, updatedAt: 1 };
  const b = { ...a, id: "b" };
  journalRepository.syncSnapshot([a, b]);
  await vi.waitFor(async () => expect((await api.select("SELECT id FROM journal_entries WHERE deleted_at IS NULL")).length).toBe(2));
  journalRepository.syncSnapshot([a]);
  await vi.waitFor(async () => expect((await api.select("SELECT id FROM journal_entries WHERE deleted_at IS NULL")).length).toBe(1));
  expect(await api.select("SELECT id FROM domain_journal")).toEqual([{ id: "a" }]);
  expect((await journalRepository.load())?.map(e => e.id)).toEqual(["a"]);
});
it("restores a fingerprint from the SQLite storage table after reopening", async () => {
  dir = mkdtempSync(join(tmpdir(), "konh-sqlite-"));
  const filename = join(dir, "storage.db");
  db = new DatabaseSync(filename);
  const makeStorage = () => {
    const memory = new Map<string, string>();
    return { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => { memory.set(k, v); }, removeItem: (k: string) => { memory.delete(k); } };
  };
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, setTimeout });
  vi.stubGlobal("localStorage", makeStorage());
  vi.resetModules();
  const first = await import('../utils/unifiedStorage');
  await first.storage.init();
  setFingerprint("account", "journal.json", "etag:persisted");
  await first.storage.flushNow();
  db.close();
  db = new DatabaseSync(filename);
  vi.stubGlobal("localStorage", makeStorage());
  vi.resetModules();
  const restarted = await import('../utils/unifiedStorage');
  await restarted.storage.init();
  expect(getFingerprint("account", "journal.json")).toBe("etag:persisted");
});
