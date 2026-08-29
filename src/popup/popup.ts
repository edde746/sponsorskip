/**
 * Popup: current-video status plus the settings that matter.
 *
 * The status block doubles as the diagnostics panel. Showing which backend
 * served the request and how long inference took is not decoration: WebGPU
 * versus WASM is a ~50x latency difference, and a user reporting "it's slow"
 * needs to be able to tell us which one they got.
 */
import * as settings from "../shared/settings";
import type { Message, SegmentsResponse } from "../shared/messages";
import type { Category, Unavailable } from "../shared/types";

const COLORS: Record<Category, string> = {
  sponsor: "#00d400",
  selfpromo: "#ffff00",
};

const EXPLANATIONS: Record<Unavailable, string> = {
  no_captions: "This video has no English captions, so there is no transcript to read.",
  fetch_failed: "Could not load the transcript. YouTube declined the request.",
  too_short: "The transcript is too short to be worth analysing.",
  no_webgpu:
    "This device has no WebGPU support, so the model cannot run accurately. "
    + "A CPU-only model was tested and missed segment boundaries by about 11 seconds, "
    + "which is worse than not skipping, so it was removed.",
  model_failed: "The model failed to run. Check the extension's service worker log.",
  llm_unconfigured:
    "LLM mode is selected but not configured. Fill in the endpoint, key and model below.",
  llm_failed:
    "The LLM endpoint failed or returned something unparseable. Check the key, "
    + "the model name, and the service worker log.",
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

interface VariantInfo {
  label: string;
  note: string;
  bundled: boolean;
  params: number;
  f1: number;
  start_abs: number;
  boundary_err: number;
}

/**
 * Model picker, described in the numbers that actually differ.
 *
 * The options are labelled with measured boundary accuracy rather than just
 * size, because "724 MB" alone gives no basis for deciding.
 */
async function wireModelChoice(config: settings.Settings): Promise<void> {
  const select = document.getElementById("model");
  const hint = document.getElementById("modelHint");
  if (!(select instanceof HTMLSelectElement)) return;

  const manifest: { variants: Record<string, VariantInfo> } = await fetch(
    chrome.runtime.getURL("variants.json"),
  ).then((r) => r.json());

  select.replaceChildren();
  for (const [id, v] of Object.entries(manifest.variants)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = `${v.label} \u2014 ${v.note}`;
    select.appendChild(option);
  }
  select.value = config.model;

  const describe = (id: string) => {
    const v = manifest.variants[id];
    if (!v) return "";
    return (
      `${(v.params / 1e6).toFixed(0)}M params \u00b7 F1 ${v.f1.toFixed(3)} \u00b7 ` +
      `start error ${v.start_abs.toFixed(2)} s \u00b7 boundary ${v.boundary_err.toFixed(2)} s`
    );
  };
  if (hint) hint.textContent = describe(config.model);

  select.addEventListener("change", () => {
    const value = select.value === "large" ? "large" : "base";
    if (hint) hint.textContent = describe(value);
    void settings.save({ model: value });
  });
}

/**
 * Show download progress for a remote variant.
 *
 * Registered before anything else asks for a detection so the first bytes are
 * not missed while the manifest loads.
 */
function wireProgress(): void {
  const wrap = document.getElementById("progress");
  const fill = document.getElementById("progressFill");
  const text = document.getElementById("progressText");
  chrome.runtime.onMessage.addListener((msg: Message) => {
    if (msg.type !== "MODEL_PROGRESS" || !wrap || !fill || !text) return;
    const pct = msg.total > 0 ? (msg.loaded / msg.total) * 100 : 0;
    wrap.hidden = false;
    fill.style.width = `${pct.toFixed(1)}%`;
    text.textContent =
      `downloading ${msg.variant}: ${(msg.loaded / 1e6).toFixed(0)} / ` +
      `${(msg.total / 1e6).toFixed(0)} MB`;
    if (msg.loaded >= msg.total && msg.total > 0) {
      text.textContent = `${msg.variant} downloaded`;
    }
  });
}


/**
 * Engine switch plus the LLM endpoint fields.
 *
 * The host permission for a user-supplied endpoint cannot be declared statically,
 * so it is requested at runtime for exactly the origin they entered. Requesting
 * it on "Test connection" rather than on every keystroke keeps the prompt tied
 * to a deliberate action.
 */
async function wireEngineChoice(config: settings.Settings): Promise<void> {
  const engine = document.getElementById("engine");
  const panel = document.getElementById("llmPanel");
  const local = document.getElementById("localPanel");
  if (!(engine instanceof HTMLSelectElement) || !panel || !local) return;

  const baseUrl = document.getElementById("llmBaseUrl");
  const apiKey = document.getElementById("llmApiKey");
  const model = document.getElementById("llmModel");
  const test = document.getElementById("llmTest");
  const status = document.getElementById("llmStatus");
  if (
    !(baseUrl instanceof HTMLInputElement) ||
    !(apiKey instanceof HTMLInputElement) ||
    !(model instanceof HTMLInputElement) ||
    !(test instanceof HTMLButtonElement) ||
    !status
  ) {
    return;
  }

  const llm = await settings.loadLlm();
  baseUrl.value = llm.baseUrl;
  apiKey.value = llm.apiKey;
  model.value = llm.model;

  const applyVisibility = (value: string) => {
    panel.hidden = value !== "llm";
    local.hidden = value === "llm";
  };
  engine.value = config.engine;
  applyVisibility(config.engine);

  engine.addEventListener("change", () => {
    const value = engine.value === "llm" ? "llm" : "local";
    applyVisibility(value);
    void settings.save({ engine: value });
  });

  for (const [input, key] of [
    [baseUrl, "baseUrl"],
    [apiKey, "apiKey"],
    [model, "model"],
  ] as const) {
    input.addEventListener("change", () => {
      void settings.saveLlm({ [key]: input.value.trim() });
    });
  }

  test.addEventListener("click", () => {
    void (async () => {
      const url = baseUrl.value.trim();
      const key = apiKey.value.trim();
      const name = model.value.trim();
      if (!url || !key || !name) {
        status.textContent = "Fill in all three fields first.";
        return;
      }
      await settings.saveLlm({ baseUrl: url, apiKey: key, model: name });

      let origin: string;
      try {
        origin = `${new URL(url).origin}/*`;
      } catch {
        status.textContent = "That endpoint is not a valid URL.";
        return;
      }

      status.textContent = "requesting permission\u2026";
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        status.textContent = `Permission for ${origin} was declined.`;
        return;
      }

      status.textContent = "testing\u2026";
      const reply: unknown = await chrome.runtime.sendMessage({ type: "TEST_LLM" });
      if (reply && typeof reply === "object" && "ok" in reply && reply.ok) {
        status.textContent = "endpoint works";
      } else {
        const detail =
          reply && typeof reply === "object" && "error" in reply
            ? String(reply.error).slice(0, 160)
            : "unknown error";
        status.textContent = `failed: ${detail}`;
      }
    })();
  });
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

  await wireEngineChoice(config);
  await wireModelChoice(config);

  const select = document.getElementById("edgeSensitivity");
  const hint = document.getElementById("edgeHint");
  if (select instanceof HTMLSelectElement) {
    select.value = config.edgeSensitivity;
    const describe = (value: settings.Settings["edgeSensitivity"]) =>
      `Edges expand while confidence stays above ${settings.EDGE_THRESHOLD[value].toFixed(2)}. ` +
      (value === "conservative"
        ? "Starts ~0.3 s after the ad on average."
        : value === "eager"
          ? "Starts ~1.4 s before the ad, so more content is cut."
          : "Starts ~0.3 s before the ad on average.");
    if (hint) hint.textContent = describe(config.edgeSensitivity);
    select.addEventListener("change", () => {
      const value = select.value as settings.Settings["edgeSensitivity"];
      if (hint) hint.textContent = describe(value);
      void settings.save({ edgeSensitivity: value });
    });
  }
}

wireProgress();
void wireControls();
void renderStatus();
