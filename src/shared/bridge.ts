/**
 * Protocol between the isolated-world content script and the main-world script.
 *
 * This bridge exists for one measured reason. The InnerTube player endpoint
 * answers based on request origin, and only the page's own world qualifies:
 *
 *   page main world (https://www.youtube.com) -> HTTP 200, 4065 words
 *   content script isolated world             -> HTTP 403 (extension origin)
 *   service worker                            -> HTTP 403 (extension origin)
 *
 * MV3 routes content-script fetches through the extension's network context, so
 * an isolated-world fetch carries `Origin: chrome-extension://...` just like the
 * worker's. Only a script injected with `world: "MAIN"` fetches as the page.
 * This is why SponsorBlock also ships a MAIN-world script alongside its
 * isolated one; it is a platform constraint, not a stylistic choice.
 */
import type { Unavailable, Word } from "./types";

export const TRANSCRIPT_REQUEST = "sponsorskip:transcript-request";
export const TRANSCRIPT_RESPONSE = "sponsorskip:transcript-response";

export interface TranscriptRequest {
  type: typeof TRANSCRIPT_REQUEST;
  videoId: string;
  /** Correlates the reply; the page can see these messages, so never trust it. */
  nonce: string;
}

export interface TranscriptPayload {
  words?: Word[];
  duration?: number;
  kind?: string;
  error?: Unavailable;
}

export interface TranscriptResponse {
  type: typeof TRANSCRIPT_RESPONSE;
  nonce: string;
  payload: TranscriptPayload;
}

/** Shape check for a message arriving from an untrusted world. */
export function isTranscriptRequest(data: unknown): data is TranscriptRequest {
  return (
    !!data &&
    typeof data === "object" &&
    "type" in data &&
    data.type === TRANSCRIPT_REQUEST &&
    "videoId" in data &&
    typeof data.videoId === "string" &&
    "nonce" in data &&
    typeof data.nonce === "string"
  );
}

export function isTranscriptResponse(data: unknown): data is TranscriptResponse {
  return (
    !!data &&
    typeof data === "object" &&
    "type" in data &&
    data.type === TRANSCRIPT_RESPONSE &&
    "nonce" in data &&
    typeof data.nonce === "string" &&
    "payload" in data
  );
}
