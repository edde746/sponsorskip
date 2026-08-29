/**
 * Isolated-world half of the transcript bridge.
 *
 * Asks the main-world script to fetch, because only it has YouTube's origin.
 * See `../shared/bridge.ts` for the measured reason.
 */
import {
  TRANSCRIPT_REQUEST,
  isTranscriptResponse,
  type TranscriptPayload,
  type TranscriptRequest,
} from "../shared/bridge";

/**
 * Give up after this long. The main-world script could be missing entirely on a
 * surface where injection failed, and hanging forever would leave the UI in a
 * permanent "analysing" state with no explanation.
 */
const TIMEOUT_MS = 20000;

export function requestTranscript(videoId: string): Promise<TranscriptPayload> {
  const nonce = crypto.randomUUID();
  const { promise, resolve } = Promise.withResolvers<TranscriptPayload>();

  const timer = window.setTimeout(() => {
    window.removeEventListener("message", onMessage);
    resolve({ error: "fetch_failed" });
  }, TIMEOUT_MS);

  function onMessage(event: MessageEvent): void {
    if (event.source !== window) return;
    if (!isTranscriptResponse(event.data) || event.data.nonce !== nonce) return;
    window.clearTimeout(timer);
    window.removeEventListener("message", onMessage);
    resolve(event.data.payload);
  }

  window.addEventListener("message", onMessage);
  const request: TranscriptRequest = { type: TRANSCRIPT_REQUEST, videoId, nonce };
  window.postMessage(request, location.origin);
  return promise;
}
