/**
 * IndexedDB cache of detection results, keyed by video id.
 *
 * Worth it because inference is the expensive step and rewatching, seeking
 * across a reload, or opening the same video in a second tab are all common.
 * Rows carry the model version so upgrading the model invalidates them instead
 * of silently serving stale segments from an older, worse detector.
 */
import { UNKNOWN_MODEL, type DetectionResult } from "../shared/types";

const DB_NAME = "sponsorskip";
const DB_VERSION = 1;
const STORE = "results";
/** Evict beyond this many rows, least-recently-touched first. */
const MAX_ROWS = 2000;

interface Row extends DetectionResult {
  /** Last read or write, ms epoch. Drives LRU eviction. */
  touched: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE, { keyPath: "videoId" }).createIndex("touched", "touched");
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
  dbPromise = promise;
  return promise;
}

/** Promisify an IDB request. Every accessor below needs identical semantics. */
function wrap<T>(req: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
  return promise;
}

/** Resolve when a readwrite transaction actually commits. */
function committed(tx: IDBTransaction): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error);
  tx.onerror = () => reject(tx.error);
  return promise;
}

export async function put(result: DetectionResult): Promise<void> {
  // Refuse to persist a row we cannot later invalidate. See UNKNOWN_MODEL.
  if (result.modelVersion === UNKNOWN_MODEL) return;
  const db = await open();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put({ ...result, touched: Date.now() } satisfies Row);
  await committed(tx);
}

export async function remove(videoId: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(videoId);
  await committed(tx);
}

export async function get(
  videoId: string,
  modelVersion: string,
): Promise<DetectionResult | null> {
  // Cannot validate a row against an unknown model, so do not try. Detection
  // reruns once and rewrites the row with a real version.
  if (modelVersion === UNKNOWN_MODEL) return null;

  const db = await open();
  const row = await wrap<Row | undefined>(
    db.transaction(STORE, "readonly").objectStore(STORE).get(videoId),
  );
  if (!row) return null;
  if (row.modelVersion !== modelVersion) {
    await remove(videoId);
    return null;
  }
  // Refresh the LRU stamp, but a failure here must not fail the read.
  void put(row).catch(() => undefined);
  return row;
}

/** Trim the store to MAX_ROWS, dropping least-recently-touched rows first. */
export async function evict(): Promise<void> {
  const db = await open();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const count = await wrap(store.count());
  if (count <= MAX_ROWS) return;

  let toDrop = count - MAX_ROWS;
  const cursorReq = store.index("touched").openCursor();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor || toDrop <= 0) {
      resolve();
      return;
    }
    cursor.delete();
    toDrop--;
    cursor.continue();
  };
  cursorReq.onerror = () => reject(cursorReq.error);
  await promise;
  await committed(tx);
}
