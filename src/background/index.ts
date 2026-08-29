/**
 * Service worker: router, cache owner, offscreen lifecycle.
 *
 * Runs neither the fetch nor the model. Transcript acquisition lives in the
 * content script because InnerTube rejects an extension origin with HTTP 403,
 * and inference lives in an offscreen document because an MV3 service worker is
 * killed after ~30s idle and has no reliable WebGPU access. What is left here
 * is exactly what needs to outlive a page: the cache, and one owned document.
 */
import * as cache from "./cache";
import * as settings from "../shared/settings";
import { detectWithLlm } from "./llm";
import type { Message, SegmentsResponse } from "../shared/messages";
import { UNKNOWN_MODEL, type DetectionResult, type Unavailable, type Word } from "../shared/types";

const OFFSCREEN_PATH = "offscreen.html";

/**
 * Failures worth remembering. A video with no English captions will never grow
 * any, so re-fetching its player response on every replay is pure waste.
 * `fetch_failed` is deliberately absent: it is usually transient, and caching
 * it would turn one bad network moment into a permanent dead video.
 */
const CACHEABLE_FAILURES: Record<Unavailable, boolean> = {
  no_captions: true,
  too_short: true,
  fetch_failed: false,
  // A device does not grow a GPU mid-session.
  no_webgpu: true,
  model_failed: false,
  // Both resolve the moment the user fixes their settings or the endpoint
  // recovers, so caching either would strand the video.
  llm_unconfigured: false,
  llm_failed: false,
};

/** Videos currently in inference, so two tabs do not both run the model. */
const inFlight = new Map<string, Promise<DetectionResult>>();

/**
 * Which model produced cached rows. Persisted, because the service worker is
 * restarted constantly and an unknown version disables the cache entirely --
 * every first video of every worker lifetime would re-run inference.
 */
let modelVersion = UNKNOWN_MODEL;

void chrome.storage.local.get("modelVersion").then((stored) => {
  if (typeof stored.modelVersion === "string" && stored.modelVersion !== UNKNOWN_MODEL) {
    modelVersion = stored.modelVersion;
  }
});

let offscreenPromise: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  offscreenPromise ??= (async () => {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (existing.length > 0) return;
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["WORKERS"],
      justification: "Runs the local sponsor-detection model on WebGPU.",
    });
  })();
  try {
    await offscreenPromise;
  } catch (err) {
    offscreenPromise = null;
    throw err;
  }
}

/**
 * Cache identity: the model AND the decode setting that produced the segments.
 *
 * Without the decode setting in the key, changing edge sensitivity would keep
 * serving segments decoded under the previous setting, and the change would
 * appear to do nothing until the cache aged out.
 */
async function cacheVersion(): Promise<string> {
  if (modelVersion === UNKNOWN_MODEL) return UNKNOWN_MODEL;
  const config = await settings.load();
  const engine = config.engine === "llm" ? "llm" : config.model;
  return `${modelVersion}|${engine}|lo=` +
    settings.EDGE_THRESHOLD[config.edgeSensitivity].toFixed(2);
}

async function runDetection(
  videoId: string,
  words: Word[],
  duration = 0,
): Promise<DetectionResult> {
  const config = await settings.load();

  if (config.engine === "llm") return runLlm(videoId, words, duration, config);

  await ensureOffscreen();
  const thresholdLo = settings.EDGE_THRESHOLD[config.edgeSensitivity];

  const reply: unknown = await chrome.runtime.sendMessage({
    type: "RUN_DETECTION",
    videoId,
    words,
    thresholdLo,
    variant: config.model,
  });

  if (!reply || typeof reply !== "object" || !("result" in reply)) {
    return { videoId, segments: [], unavailable: "model_failed", modelVersion };
  }
  // Internal IPC from our own offscreen document, which constructs this object
  // directly; there is no external input to validate here.
  const result = reply.result as DetectionResult;
  if (result.modelVersion !== UNKNOWN_MODEL && result.modelVersion !== modelVersion) {
    modelVersion = result.modelVersion;
    void chrome.storage.local.set({ modelVersion });
  }
  const stored: DetectionResult = { ...result, modelVersion: await cacheVersion() };
  await cache.put(stored);
  void cache.evict();
  return result;
}

async function runLlm(
  videoId: string,
  words: Word[],
  duration: number,
  config: settings.Settings,
): Promise<DetectionResult> {
  const llm = await settings.loadLlm();
  if (!llm.apiKey || !llm.baseUrl || !llm.model) {
    return { videoId, segments: [], unavailable: "llm_unconfigured", modelVersion: "llm" };
  }

  const version = `llm:${llm.model}`;
  const started = Date.now();
  const result = await detectWithLlm(words, duration, llm);
  if (result.error || !result.segments) {
    console.warn(`[sponsorskip] llm failed: ${result.error}`);
    return { videoId, segments: [], unavailable: "llm_failed", modelVersion: version };
  }

  const detection: DetectionResult = {
    videoId,
    segments: result.segments,
    inferenceMs: Date.now() - started,
    modelVersion: version,
  };
  if (version !== modelVersion) {
    modelVersion = version;
    void chrome.storage.local.set({ modelVersion });
  }
  await cache.put({ ...detection, modelVersion: await cacheVersion() });
  void cache.evict();
  return detection;
}

function respond(result: DetectionResult): SegmentsResponse {
  return {
    status: result.unavailable ? "error" : "ready",
    segments: result.segments,
    result,
  };
}

async function lookup(videoId: string): Promise<DetectionResult | null> {
  return cache.get(videoId, await cacheVersion());
}

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  if (msg.type === "REQUEST_SEGMENTS") {
    const pending = inFlight.get(msg.videoId);
    if (pending) {
      pending.then((r) => sendResponse(respond(r)), () => sendResponse({ status: "error" }));
      return true;
    }
    lookup(msg.videoId).then(
      (hit) =>
        sendResponse(
          hit ? respond(hit) : ({ status: "need_transcript" } satisfies SegmentsResponse),
        ),
      // A cache read failure should not block detection; ask for the transcript.
      () => sendResponse({ status: "need_transcript" } satisfies SegmentsResponse),
    );
    return true;
  }

  if (msg.type === "SUBMIT_TRANSCRIPT") {
    const existing = inFlight.get(msg.videoId);
    const job =
      existing ??
      runDetection(msg.videoId, msg.words, msg.duration).finally(() =>
        inFlight.delete(msg.videoId),
      );
    if (!existing) inFlight.set(msg.videoId, job);
    job.then(
      (result) => sendResponse(respond(result)),
      (err) => {
        console.error("[sponsorskip] detection failed", err);
        sendResponse({ status: "error" } satisfies SegmentsResponse);
      },
    );
    return true;
  }

  if (msg.type === "REPORT_UNAVAILABLE") {
    const reason = msg.reason ?? "fetch_failed";
    const result: DetectionResult = {
      videoId: msg.videoId,
      segments: [],
      unavailable: reason,
      modelVersion,
    };
    if (CACHEABLE_FAILURES[reason]) void cache.put(result);
    return false;
  }

  if (msg.type === "TEST_LLM") {
    // Round-trip a tiny synthetic transcript. Cheaper than a real video and it
    // exercises the whole path: auth, model name, and JSON recovery.
    void (async () => {
      const llm = await settings.loadLlm();
      const probe = await detectWithLlm(
        [
          ["this", 0],
          ["video", 500],
          ["is", 1000],
          ["brought", 1500],
          ["to", 2000],
          ["you", 2500],
          ["by", 3000],
          ["Acme", 3500],
          ["dot", 4000],
          ["com", 4500],
        ],
        10,
        llm,
      );
      sendResponse(probe.error ? { ok: false, error: probe.error } : { ok: true });
    })();
    return true;
  }

  if (msg.type === "MODEL_PROGRESS") return false;

  if (msg.type === "FORGET_VIDEO") {
    void cache.remove(msg.videoId);
    return false;
  }

  if (msg.type === "REQUEST_STATUS") {
    lookup(msg.videoId).then(
      (row) =>
        sendResponse(
          row
            ? respond(row)
            : ({
                status: inFlight.has(msg.videoId) ? "pending" : "need_transcript",
              } satisfies SegmentsResponse),
        ),
      () => sendResponse({ status: "error" } satisfies SegmentsResponse),
    );
    return true;
  }

  return false;
});
