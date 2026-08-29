/** Shared vocabulary between content script, service worker and offscreen doc. */

/** Ad category. Mirrors the model's label set, collapsed to the two brands. */
export type Category = "sponsor" | "selfpromo";

/** A detected ad segment, in seconds relative to video start. */
export interface Segment {
  category: Category;
  start: number;
  end: number;
  /**
   * Mean ad probability over the span, when the engine produces one.
   *
   * Absent for LLM detections: that engine returns spans with no probability,
   * and inventing a 1.0 would render as "100% confident" in the UI, which is a
   * claim nothing measured.
   */
  score?: number;
}

/**
 * One transcript word with its caption timestamp.
 *
 * Deliberately a tuple, not an object: a 3-hour video is ~30k words and this
 * crosses two structured-clone boundaries (content -> worker -> offscreen) per
 * video. Tuples clone ~3x cheaper than `{text, ms}` objects.
 */
export type Word = [text: string, ms: number];

/** Why we have no segments for a video. Drives the popup's explanation. */
export type Unavailable =
  | "no_captions" // video has no English caption track
  | "fetch_failed" // InnerTube said no, or the network did
  | "too_short" // not enough transcript to be worth running
  | "no_webgpu" // device cannot run the model accurately enough to be useful
  | "llm_unconfigured" // LLM engine selected but no endpoint/key/model set
  | "llm_failed" // the configured endpoint refused, or returned unparseable output
  | "model_failed"; // session create / inference threw

export interface DetectionResult {
  videoId: string;
  segments: Segment[];
  /** Set when `segments` is empty for a reason other than "clean video". */
  unavailable?: Unavailable;
  /** Wall-clock ms the model spent, for the diagnostics panel. */
  inferenceMs?: number;
  /** Which execution provider actually served the request. */
  backend?: "webgpu" | "wasm";
  /** Schema/model version, so a cached row from an older model is discarded. */
  modelVersion: string;
}

/**
 * Placeholder used before the offscreen document has reported which model it
 * loaded.
 *
 * It is a hard rule that this value is never written to the cache and never
 * matches on read. Otherwise it collides with itself: a row stored early in one
 * session carries "unknown", a lookup early in the next session also passes
 * "unknown", and the version check that exists to invalidate stale rows instead
 * validates them. That bug served a poisoned negative result indefinitely.
 */
export const UNKNOWN_MODEL = "unknown";

export interface DetectorMeta {
  keep: number[];
  tokenizer: string;
  labels: string[];
  max_len: number;
  stride_frac: number;
  /**
   * Detection threshold. A word must exceed this for a segment to exist at all.
   * Kept for older artifacts that predate the hysteresis pair.
   */
  threshold: number;
  /**
   * Hysteresis pair. `threshold_hi` decides *whether* a segment is there;
   * `threshold_lo` decides *where its edges are* by expanding outward from the
   * confident core.
   *
   * One threshold cannot do both jobs, and trying cost real accuracy: measured
   * on crowd labels, raising a single threshold bought F1 and pushed segment
   * starts later, so the shipped model began sponsor skips +2.4 s late.
   * Splitting them gave better F1 *and* 2.7 s less lateness simultaneously.
   */
  threshold_hi?: number;
  threshold_lo?: number;
  cls_token_id: number;
  sep_token_id: number;
  pad_token_id: number;
  params: number;
  test_f1: number;
}
