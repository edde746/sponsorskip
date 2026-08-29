/**
 * Main-world script. Its entire job is to be YouTube's own origin.
 *
 * Injected with `world: "MAIN"`, so `fetch` here carries
 * `Origin: https://www.youtube.com` and InnerTube answers it. Nothing else
 * belongs in this file: it shares a global scope with YouTube's own code and
 * has no access to extension APIs.
 */
import { fetchTranscript } from "./transcript";
import {
  TRANSCRIPT_RESPONSE,
  isTranscriptRequest,
  type TranscriptResponse,
} from "../shared/bridge";

window.addEventListener("message", (event: MessageEvent) => {
  // Only same-window messages, and only our own request shape.
  if (event.source !== window) return;
  if (!isTranscriptRequest(event.data)) return;

  const { videoId, nonce } = event.data;
  void fetchTranscript(videoId).then(
    (payload) => {
      const message: TranscriptResponse = { type: TRANSCRIPT_RESPONSE, nonce, payload };
      window.postMessage(message, location.origin);
    },
    () => {
      const message: TranscriptResponse = {
        type: TRANSCRIPT_RESPONSE,
        nonce,
        payload: { error: "fetch_failed" },
      };
      window.postMessage(message, location.origin);
    },
  );
});
