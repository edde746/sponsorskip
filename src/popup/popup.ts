/**
 * Popup: current-video status plus the settings that matter.
 *
 * The status block doubles as the diagnostics panel. Showing which backend
 * served the request and how long inference took is not decoration: WebGPU
 * versus WASM is a ~50x latency difference, and a user reporting "it's slow"
 * needs to be able to tell us which one they got.
 */
import * as settings from "../shared/settings";
import type { SegmentsResponse } from "../shared/messages";
import type { Category, Unavailable } from "../shared/types";

const COLORS: Record<Category, string> = {
  sponsor: "#00d400",
  selfpromo: "#ffff00",
};

const EXPLANATIONS: Record<Unavailable, string> = {
  no_captions: "This video has no English captions, so there is no transcript to read.",
  fetch_failed: "Could not load the transcript. YouTube declined the request.",
  too_short: "The transcript is too short to be worth analysing.",
  model_failed: "The model failed to run. Check the extension's service worker log.",
};

function timestamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function currentVideoId(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  const url = new URL(tab.url);
  if (!url.hostname.endsWith("youtube.com")) return null;
  if (url.pathname === "/watch") return url.searchParams.get("v");
  const m = /^\/(?:shorts|embed)\/([\w-]{11})/.exec(url.pathname);
  return m ? m[1] : null;
}

async function renderStatus(): Promise<void> {
  const status = document.getElementById("status");
  const model = document.getElementById("model");
  if (!status || !model) return;

  const videoId = await currentVideoId();
  if (!videoId) {
    status.textContent = "Open a YouTube video to see detected segments.";
    return;
  }

  let response: SegmentsResponse | undefined;
  try {
    response = await chrome.runtime.sendMessage({ type: "REQUEST_STATUS", videoId });
  } catch {
    status.textContent = "The detector is not responding.";
    return;
  }

  const result = response?.result;
  if (!result || response?.status === "pending") {
    status.textContent = "Analysing this video\u2026";
    return;
  }

  if (result.unavailable) {
    status.textContent = EXPLANATIONS[result.unavailable];
    return;
  }

  model.textContent = [
    result.modelVersion,
    result.backend ? `via ${result.backend.toUpperCase()}` : null,
    result.inferenceMs !== undefined ? `${result.inferenceMs} ms` : null,
  ]
    .filter(Boolean)
    .join(" \u00b7 ");

  if (result.segments.length === 0) {
    status.textContent = "No sponsor segments found in this video.";
    return;
  }

  status.replaceChildren();
  const heading = document.createElement("div");
  const count = result.segments.length;
  heading.textContent = `${count} segment${count === 1 ? "" : "s"} detected`;

  const list = document.createElement("ul");
  list.id = "segments";
  for (const segment of result.segments) {
    const row = document.createElement("li");
    const left = document.createElement("span");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.backgroundColor = COLORS[segment.category];
    left.append(swatch, document.createTextNode(segment.category));
    const right = document.createElement("span");
    right.textContent = `${timestamp(segment.start)} \u2013 ${timestamp(segment.end)}`;
    row.append(left, right);
    list.appendChild(row);
  }
  status.append(heading, list);
}

async function wireControls(): Promise<void> {
  const config = await settings.load();

  const toggles: Array<[string, boolean, (checked: boolean) => Partial<settings.Settings>]> =
    [
      ["enabled", config.enabled, (v) => ({ enabled: v })],
      ["autoSkip", config.autoSkip, (v) => ({ autoSkip: v })],
      ["showPreviewBar", config.showPreviewBar, (v) => ({ showPreviewBar: v })],
      [
        "cat-sponsor",
        config.categories.sponsor,
        (v) => ({ categories: { ...config.categories, sponsor: v } }),
      ],
      [
        "cat-selfpromo",
        config.categories.selfpromo,
        (v) => ({ categories: { ...config.categories, selfpromo: v } }),
      ],
    ];

  for (const [id, initial, patch] of toggles) {
    const input = document.getElementById(id);
    if (!(input instanceof HTMLInputElement)) continue;
    input.checked = initial;
    input.addEventListener("change", () => {
      void settings.save(patch(input.checked));
    });
  }
}

void wireControls();
void renderStatus();
