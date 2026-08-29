/**
 * Message protocol. Content script <-> service worker <-> offscreen document.
 *
 * The split is dictated by where each capability actually exists:
 *  - Only the content script can fetch the transcript (InnerTube 403s on an
 *    extension origin), so it owns acquisition.
 *  - Only the service worker outlives a page, so it owns the cache and the
 *    offscreen document's lifecycle.
 *  - Only a document can use WebGPU, so the offscreen document owns the model.
 *
 * Hence the two-step handshake: the content script asks first, and only pays
 * for a transcript fetch when the worker reports a cache miss.
 */
import type { DetectionResult, Segment, Word } from "./types";

/** Step 1: content script asks whether we already know this video. */
export interface RequestSegments {
  type: "REQUEST_SEGMENTS";
  videoId: string;
}

/** Step 2: cache missed, so the content script fetched a transcript. */
export interface SubmitTranscript {
  type: "SUBMIT_TRANSCRIPT";
  videoId: string;
  words: Word[];
}

/** Content script could not get a transcript; record why, without inference. */
export interface ReportUnavailable {
  type: "REPORT_UNAVAILABLE";
  videoId: string;
  reason: DetectionResult["unavailable"];
}

/** Service worker hands work to the offscreen document. */
export interface RunDetection {
  type: "RUN_DETECTION";
  videoId: string;
  words: Word[];
}

/** User pressed "never skip this" -- drop the cached row. */
export interface ForgetVideo {
  type: "FORGET_VIDEO";
  videoId: string;
}

/** Popup wants the current tab's state without triggering work. */
export interface RequestStatus {
  type: "REQUEST_STATUS";
  videoId: string;
}

export type Message =
  | RequestSegments
  | SubmitTranscript
  | ReportUnavailable
  | RunDetection
  | ForgetVideo
  | RequestStatus;

export interface SegmentsResponse {
  /**
   * `need_transcript` is the cache-miss signal that asks the content script to
   * do the fetch it alone is able to do.
   */
  status: "ready" | "need_transcript" | "pending" | "error";
  segments?: Segment[];
  result?: DetectionResult;
}
