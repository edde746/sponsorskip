/**
 * Offscreen document: owns the ONNX session for the life of the browser session.
 *
 * Loading the graph costs real time and memory, so the session is created once,
 * lazily, and reused. Requests are serialised through a single chain because two
 * concurrent WebGPU sessions on the same graph buy nothing and can exhaust GPU
 * memory on modest hardware.
 */
import { Detector } from "./detector";
import type { Message } from "../shared/messages";
import type { DetectionResult, Word } from "../shared/types";

let detector: Detector | null = null;
let loading: Promise<Detector> | null = null;
/** Tail of the work queue; new jobs append so only one runs at a time. */
let queue: Promise<unknown> = Promise.resolve();

async function getDetector(): Promise<Detector> {
  if (detector) return detector;
  loading ??= (async () => {
    const d = new Detector();
    await d.init({ baseUrl: chrome.runtime.getURL("models") });
    detector = d;
    return d;
  })();
  try {
    return await loading;
  } catch (err) {
    // Let a later request retry rather than poisoning the document forever.
    loading = null;
    throw err;
  }
}

async function run(videoId: string, words: Word[]): Promise<DetectionResult> {
  const started = performance.now();
  try {
    const d = await getDetector();
    const segments = await d.detect(words);
    return {
      videoId,
      segments,
      inferenceMs: Math.round(performance.now() - started),
      backend: d.backend,
      modelVersion: d.modelVersion,
    };
  } catch (err) {
    console.error("[sponsorskip] inference failed", err);
    return {
      videoId,
      segments: [],
      unavailable: "model_failed",
      modelVersion: detector?.modelVersion ?? "unknown",
    };
  }
}

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  if (msg.type !== "RUN_DETECTION") return false;
  queue = queue.then(async () => {
    sendResponse({ type: "DETECTION_DONE", result: await run(msg.videoId, msg.words) });
  });
  return true; // async sendResponse
});
