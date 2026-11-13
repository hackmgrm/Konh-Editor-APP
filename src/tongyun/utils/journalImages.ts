const DB_NAME = "tongyun_journal_images";
const STORE_NAME = "images";
// Bound both decoded bytes and the number of records before allocating backup data.
export const JOURNAL_IMAGE_MAX_COUNT = 1000;
export const JOURNAL_IMAGE_MAX_BYTES = 50 * 1024 * 1024;

function openDB(name = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveJournalImage(id: string, data: Blob): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(data, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadJournalImage(id: string): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteJournalImage(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export interface JournalImageBackup {
  version: 1;
  images: Array<{ id: string; type: string; size: number; base64: string; file?: { name: string; lastModified: number } }>;
}

/** Export a transactionally consistent snapshot of the journal image store, not other journal data. */
export async function exportJournalImages(): Promise<JournalImageBackup> {
  const db = await openDB();
  try {
    const entries = await new Promise<Array<{ id: string; blob: Blob }>>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const entries: Array<{ id: string; blob: Blob }> = [];
      let totalBytes = 0;
      const req = tx.objectStore(STORE_NAME).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        if (typeof cursor.key !== "string" || !(cursor.value instanceof Blob)) {
          tx.abort();
          return;
        }
        totalBytes += cursor.value.size;
        if (entries.length >= JOURNAL_IMAGE_MAX_COUNT || totalBytes > JOURNAL_IMAGE_MAX_BYTES) {
          tx.abort();
          return;
        }
        entries.push({ id: cursor.key, blob: cursor.value });
        cursor.continue();
      };
      tx.oncomplete = () => resolve(entries);
      tx.onabort = () => reject(tx.error ?? new Error("Invalid journal image record"));
      tx.onerror = () => reject(tx.error);
    });
    const images: JournalImageBackup["images"] = [];
    for (const { id, blob } of entries) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      images.push({ id, type: blob.type, size: blob.size, base64: btoa(binary),
        ...(typeof File !== "undefined" && blob instanceof File ? { file: { name: blob.name, lastModified: blob.lastModified } } : {}) });
    }
    return { version: 1, images };
  } finally { db.close(); }
}

/** Validate and decode a backup without touching any database. */
export function decodeJournalImageBackup(backup: JournalImageBackup): Array<{ id: string; blob: Blob }> {
  if (!backup || backup.version !== 1 || !Array.isArray(backup.images)) throw new Error("Invalid journal image backup");
  if (backup.images.length > JOURNAL_IMAGE_MAX_COUNT) throw new Error("Journal image backup exceeds resource limits");
  const ids = new Set<string>();
  let totalBytes = 0;
  // Validate all sizes and encoded lengths before decoding any image.
  for (const image of backup.images) {
    if (!image || typeof image.id !== "string" || ids.has(image.id) || typeof image.type !== "string" ||
        !Number.isSafeInteger(image.size) || image.size < 0 || typeof image.base64 !== "string") throw new Error("Invalid journal image record");
    ids.add(image.id);
    totalBytes += image.size;
    if (totalBytes > JOURNAL_IMAGE_MAX_BYTES || image.base64.length !== 4 * Math.ceil(image.size / 3)) throw new Error("Journal image backup exceeds resource limits or has invalid size");
    if (/[^A-Za-z0-9+/=]/.test(image.base64) || /=/.test(image.base64.slice(0, -2)) || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.base64)) throw new Error("Invalid journal image record");
    if (image.file !== undefined && (!image.file || typeof image.file.name !== "string" || !Number.isFinite(image.file.lastModified))) throw new Error("Invalid journal image file metadata");
    if (image.file && typeof File === "undefined") throw new Error("File metadata cannot be restored in this environment");
  }
  const entries = backup.images.map((image) => {
    const binary = atob(image.base64);
    if (binary.length !== image.size || btoa(binary) !== image.base64) throw new Error("Invalid journal image data");
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const blob = image.file ? new File([bytes], image.file.name, { type: image.type, lastModified: image.file.lastModified }) : new Blob([bytes], { type: image.type });
    if (blob.type !== image.type) throw new Error("Invalid journal image MIME type");
    return { id: image.id, blob };
  });
  return entries;
}

/**
 * Replace the live journal image store with the contents of a backup.
 *
 * Clearing and writing happen inside one IndexedDB transaction, so an
 * interrupted restore leaves the previous images untouched. Callers must have
 * stopped planner writes first; the count check afterwards catches a partially
 * applied restore that the transaction machinery would otherwise hide.
 */
export async function restoreJournalImagesInPlace(backup: JournalImageBackup): Promise<number> {
  const entries = decodeJournalImageBackup(backup);
  const sizeOf = new Map(entries.map((entry) => [entry.id, entry.blob.size]));
  const db = await openDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      for (const entry of entries) store.put(entry.blob, entry.id);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("Journal image restore aborted"));
      tx.onerror = () => {}; // The abort handler reports the failure.
    });
    const restored = await new Promise<Map<string, number>>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const sizes = new Map<string, number>();
      const countReq = store.count();
      countReq.onsuccess = () => {
        if (countReq.result !== entries.length) {
          reject(new Error(`Journal image count mismatch: expected ${entries.length}, found ${countReq.result}`));
          return;
        }
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          if (typeof cursor.key !== "string" || !(cursor.value instanceof Blob)) {
            reject(new Error("Restored journal image has an invalid record"));
            return;
          }
          sizes.set(cursor.key, cursor.value.size);
          cursor.continue();
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      };
      countReq.onerror = () => reject(countReq.error);
      tx.oncomplete = () => resolve(sizes);
      tx.onabort = () => reject(tx.error ?? new Error("Journal image verification aborted"));
      tx.onerror = () => {};
    });
    for (const [id, size] of sizeOf) {
      if (restored.get(id) !== size) throw new Error(`Restored journal image ${id} has the wrong size`);
    }
    return restored.size;
  } finally {
    db.close();
  }
}

/** Restore only into a newly created, separately named IndexedDB database. */
export async function restoreJournalImagesIsolated(backup: JournalImageBackup, databaseName: string): Promise<number> {
  if (typeof databaseName !== "string" || !databaseName.trim() || databaseName === DB_NAME) throw new Error("An isolated database name is required");
  const entries = decodeJournalImageBackup(backup);
  // Creation and the oldVersion check happen in the same exclusive upgrade transaction.
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    let created = false;
    const req = indexedDB.open(databaseName, 1);
    req.onupgradeneeded = (event) => {
      if (event.oldVersion !== 0) { req.transaction!.abort(); return; }
      created = true;
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => {
      if (!created) { req.result.close(); reject(new Error("Staging database already exists")); }
      else resolve(req.result);
    };
    req.onerror = () => reject(req.error ?? new Error("Cannot create staging database"));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      for (const entry of entries) tx.objectStore(STORE_NAME).add(entry.blob, entry.id);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("Journal image restore aborted"));
      tx.onerror = () => {}; // The abort handler reports the transaction failure.
    });
  } catch (error) {
    db.close();
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(databaseName);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error("Failed to clean up staging database", { cause: req.error }));
      req.onblocked = () => reject(new Error("Staging database cleanup blocked"));
    });
    throw error;
  }
  db.close();
  return entries.length;
}

/** Convert a Blob to a base64 data URL */
export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
