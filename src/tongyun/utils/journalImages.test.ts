// @vitest-environment node
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { exportJournalImages, restoreJournalImagesIsolated, saveJournalImage, deleteJournalImage, JOURNAL_IMAGE_MAX_BYTES, JOURNAL_IMAGE_MAX_COUNT } from "./journalImages";

async function readImage(dbName: string, id: string): Promise<Blob | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction("images").objectStore("images").get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

describe("journal image backup", () => {
  it("round trips actual IndexedDB blobs and rejects collisions atomically", async () => {
    await saveJournalImage("backup-test-image", new Blob([new Uint8Array([0, 1, 255])], { type: "image/png" }));
    const backup = await exportJournalImages();
    const image = backup.images.find((entry) => entry.id === "backup-test-image")!;
    expect(image).toEqual({ id: "backup-test-image", type: "image/png", size: 3, base64: "AAH/" });
    const name = `isolated-${Math.random()}`;
    expect(await restoreJournalImagesIsolated(backup, name)).toBe(backup.images.length);
    const restored = (await readImage(name, image.id))!;
    expect(restored.type).toBe("image/png");
    expect([...new Uint8Array(await restored.arrayBuffer())]).toEqual([0, 1, 255]);
    await expect(restoreJournalImagesIsolated({ version: 1, images: [
      { id: "new", type: "", size: 0, base64: "" }, image,
    ] }, name)).rejects.toThrow();
    expect(await readImage(name, "new")).toBeUndefined();
    expect((await readImage(name, image.id))!.size).toBe(3);
  });

  it("rejects existing empty databases and validates limits before decoding", async () => {
    const name = `empty-${Math.random()}`;
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("images");
      req.onsuccess = () => { req.result.close(); resolve(); };
      req.onerror = () => reject(req.error);
    });
    await expect(restoreJournalImagesIsolated({ version: 1, images: [] }, name)).rejects.toThrow();
    const decode = vi.spyOn(globalThis, "atob");
    try {
      await expect(restoreJournalImagesIsolated({ version: 1, images: [
        { id: "a", type: "", size: 1, base64: "AA==" },
        { id: "b", type: "", size: JOURNAL_IMAGE_MAX_BYTES + 1, base64: "" },
      ] }, `limit-${Math.random()}`)).rejects.toThrow();
      await expect(restoreJournalImagesIsolated({ version: 1, images: Array(JOURNAL_IMAGE_MAX_COUNT + 1).fill({}) }, `count-${Math.random()}`)).rejects.toThrow();
      expect(decode).not.toHaveBeenCalled();
    } finally { decode.mockRestore(); }
  });

  it("removes a newly created staging database when writing fails", async () => {
    const name = `failed-${Math.random()}`;
    const add = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(() => { throw new Error("write failed"); });
    try {
      await expect(restoreJournalImagesIsolated({ version: 1, images: [{ id: "x", type: "", size: 0, base64: "" }] }, name)).rejects.toThrow("write failed");
    } finally { add.mockRestore(); }
    expect((await indexedDB.databases()).some((db) => db.name === name)).toBe(false);
  });

  it("bounds export before reading blobs", async () => {
    const id = `large-${Math.random()}`;
    await saveJournalImage(id, new Blob([new Uint8Array(JOURNAL_IMAGE_MAX_BYTES + 1)]));
    try { await expect(exportJournalImages()).rejects.toThrow(); }
    finally { await deleteJournalImage(id); }
  });

  it("rejects malformed, duplicate, and live database restores before writing", async () => {
    const image = { id: "x", type: "image/png", size: 1, base64: "AA==" };
    await expect(restoreJournalImagesIsolated({ version: 1, images: [image] }, "tongyun_journal_images")).rejects.toThrow();
    await expect(restoreJournalImagesIsolated({ version: 1, images: [image, image] }, "duplicate")).rejects.toThrow();
    await expect(restoreJournalImagesIsolated({ version: 1, images: [{ ...image, size: 2 }] }, "invalid")).rejects.toThrow();
    await expect(restoreJournalImagesIsolated({ version: 2, images: [] } as never, "invalid")).rejects.toThrow();
  });
});
