/**
 * Model acquisition: bundled files, or a verified one-time download.
 *
 * The `large` variant is 724 MB, which is too much to put in the extension
 * package, so it is fetched on demand and kept in the Cache API. Two properties
 * matter more than the plumbing:
 *
 *  - **Integrity is checked, not assumed.** A truncated or substituted graph
 *    would not crash; it would quietly predict worse segments. Every downloaded
 *    file is verified against a SHA-256 recorded at build time, and a mismatch
 *    is discarded rather than cached.
 *  - **Progress is reported.** A silent 724 MB download looks like a hang, so
 *    bytes are streamed and forwarded to the popup.
 */

export interface VariantFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface Variant {
  label: string;
  note: string;
  bundled: boolean;
  model?: string;
  meta?: string;
  params: number;
  bytes: number;
  f1: number;
  start_abs: number;
  boundary_err: number;
  files?: { model: VariantFile; meta: VariantFile };
}

export interface Manifest {
  repo: string;
  revision: string;
  /**
   * Where remote files live, as a template over `repo`/`revision`/`path`.
   *
   * In the manifest rather than in code so the host is configuration: it lets a
   * download be pointed at a local server for testing without touching the
   * fetch/verify/cache logic being tested.
   */
  urlTemplate?: string;
  variants: Record<string, Variant>;
}

export type ProgressFn = (loaded: number, total: number) => void;

const CACHE_NAME = "sponsorskip-models";

export async function loadManifest(): Promise<Manifest> {
  return fetch(chrome.runtime.getURL("variants.json")).then((r) => r.json());
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetch with progress. Uses the streaming body rather than `arrayBuffer()` so a
 * long download can report movement instead of appearing to hang.
 */
async function fetchWithProgress(
  url: string,
  expectedBytes: number,
  onProgress: ProgressFn,
): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);

  // Content-Length is absent behind some CDNs; fall back to the manifest size so
  // the progress bar still has a denominator.
  const declared = Number(response.headers.get("content-length") ?? 0);
  const total = declared > 0 ? declared : expectedBytes;

  const reader = response.body?.getReader();
  if (!reader) return response.arrayBuffer();

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }

  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

/**
 * Bytes for one remote file: cache, else download, verify, then cache.
 *
 * A cache hit is trusted without re-hashing. Re-verifying 724 MB on every
 * browser start would cost seconds of CPU to guard against local cache
 * corruption, which is not the threat this check exists for.
 */
async function remoteBytes(
  manifest: Manifest,
  file: VariantFile,
  onProgress: ProgressFn,
): Promise<ArrayBuffer> {
  const template =
    manifest.urlTemplate ??
    "https://huggingface.co/{repo}/resolve/{revision}/{path}";
  const url = template
    .replace("{repo}", manifest.repo)
    .replace("{revision}", manifest.revision)
    .replace("{path}", file.path);
  const hit = await (await caches.open(CACHE_NAME)).match(url);
  if (hit) {
    const bytes = await hit.arrayBuffer();
    if (bytes.byteLength === file.bytes) return bytes;
  }

  const bytes = await fetchWithProgress(url, file.bytes, onProgress);
  if (bytes.byteLength !== file.bytes) {
    throw new Error(
      `${file.path}: got ${bytes.byteLength} bytes, expected ${file.bytes}`,
    );
  }
  const digest = await sha256Hex(bytes);
  if (digest !== file.sha256) {
    throw new Error(`${file.path}: sha256 ${digest} != ${file.sha256}`);
  }

  const cache = await caches.open(CACHE_NAME);
  await cache.put(url, new Response(bytes));
  return bytes;
}

export interface ResolvedVariant {
  /** ONNX graph bytes, ready for InferenceSession.create. */
  model: ArrayBuffer;
  meta: unknown;
  /** Stable identity for cache keys: model choice plus its content hash. */
  version: string;
}

export async function resolveVariant(
  manifest: Manifest,
  id: string,
  onProgress: ProgressFn,
): Promise<ResolvedVariant> {
  const variant = manifest.variants[id];
  if (!variant) throw new Error(`unknown model variant ${id}`);

  if (variant.bundled) {
    const [model, meta] = await Promise.all([
      fetch(chrome.runtime.getURL(variant.model!)).then((r) => r.arrayBuffer()),
      fetch(chrome.runtime.getURL(variant.meta!)).then((r) => r.json()),
    ]);
    return { model, meta, version: `${id}-bundled` };
  }

  const files = variant.files!;
  // Meta first: it is tiny, so a broken manifest or a missing revision fails in
  // a second instead of after a 724 MB transfer.
  const metaBytes = await remoteBytes(manifest, files.meta, () => undefined);
  const meta = JSON.parse(new TextDecoder().decode(metaBytes));
  const model = await remoteBytes(manifest, files.model, onProgress);
  return { model, meta, version: `${id}-${files.model.sha256.slice(0, 12)}` };
}
