/**
 * Offscreen document: owns the ONNX session for the life of the browser session.
 *
 * Loading the graph costs real time and memory, so the session is created once,
 * lazily, and reused. Requests are serialised through a single chain because two
 * concurrent WebGPU sessions on the same graph buy nothing and can exhaust GPU
 * memory on modest hardware.
 */
import { Detector, NoWebGPUError } from "./detector";
import type { Message } from "../shared/messages";
import type { DetectionResult, Word } from "../shared/types";

let detector: Detector | null = null;
let loading: Promise<Detector> | null = null;
/** Which variant the live detector holds, so a settings change reloads it. */
let loadedVariant: string | null = null;
/** Tail of the work queue; new jobs append so only one runs at a time. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Broadcast download progress so the popup can show it.
 *
 * Fire-and-forget: nothing is listening unless the popup is open, and a
 * "receiving end does not exist" rejection there is expected, not an error.
 */
function reportProgress(variant: string, loaded: number, total: number): void {
  void chrome.runtime
    .sendMessage({ type: "MODEL_PROGRESS", variant, loaded, total })
    .catch(() => undefined);
}

async function getDetector(variant: string): Promise<Detector> {
  // A variant switch must drop the old session; two 700 MB graphs will not both
  // fit on modest hardware.
  if (detector && loadedVariant !== variant) {
    detector = null;
    loading = null;
  }
  if (detector) return detector;

  loading ??= (async () => {
    const d = new Detector();
    await d.init({
      variant,
      onProgress: (loaded, total) => reportProgress(variant, loaded, total),
    });
    detector = d;
    loadedVariant = variant;
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

async function run(
  videoId: string,
  words: Word[],
  thresholdLo?: number,
  variant = "base",
): Promise<DetectionResult> {
  const started = performance.now();
  try {
    const d = await getDetector(variant);
    const segments = await d.detect(words, thresholdLo);
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
      unavailable: err instanceof NoWebGPUError ? "no_webgpu" : "model_failed",
      modelVersion: detector?.modelVersion ?? "unknown",
    };
  }
}

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  if (msg.type !== "RUN_DETECTION") return false;
  queue = queue.then(async () => {
    sendResponse({
      type: "DETECTION_DONE",
      result: await run(msg.videoId, msg.words, msg.thresholdLo, msg.variant),
    });
  });
  return true; // async sendResponse
});
