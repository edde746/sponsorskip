/**
 * User settings, persisted in chrome.storage.sync.
 *
 * Reads validate field by field rather than trusting the stored object. Synced
 * storage is a genuine external boundary: it can hold values written by an older
 * version of this extension, or by a newer one on another machine.
 */
import type { Category } from "./types";

export interface Settings {
  enabled: boolean;
  /** Seek automatically, versus only offering a manual skip button. */
  autoSkip: boolean;
  /** Which categories to act on at all. */
  categories: Record<Category, boolean>;
  /** Seconds the "skipped" toast stays up. 0 hides it entirely. */
  noticeDuration: number;
  /** Draw detected spans on the progress bar. */
  showPreviewBar: boolean;
  /**
   * How far segment edges are allowed to expand outward from the confident
   * core, i.e. the low threshold of the hysteresis decode.
   *
   * This is a taste knob, not a correctness one, and it is exposed because the
   * right answer depends on the user. Measured on SponsorBlock crowd labels:
   *   conservative (0.40): starts +0.32 s late on average, keeps more content
   *   balanced     (0.30): starts -0.32 s early, the default
   *   eager        (0.20): starts -1.40 s early, rarely lets any ad through
   */
  edgeSensitivity: "conservative" | "balanced" | "eager";
  /**
   * Which detector to run. `base` is bundled and works offline; `large` is a
   * 724 MB one-time download with measurably better boundaries (mean absolute
   * start error 2.33 s against base's 2.98 s, and it overshoots segment ends by
   * 0.46 s against 1.28 s).
   */
  model: "base" | "large";
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  autoSkip: true,
  categories: { sponsor: true, selfpromo: true },
  noticeDuration: 6,
  showPreviewBar: true,
  edgeSensitivity: "balanced",
  model: "base",
};

/**
 * Edge sensitivity -> hysteresis low threshold.
 *
 * The high threshold stays fixed at the model's own tuned value: it controls
 * whether a segment is detected at all, which is not a matter of taste.
 */
export const EDGE_THRESHOLD: Record<Settings["edgeSensitivity"], number> = {
  conservative: 0.4,
  balanced: 0.3,
  eager: 0.2,
};

function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readCategories(value: unknown): Record<Category, boolean> {
  if (!value || typeof value !== "object") return { ...DEFAULT_SETTINGS.categories };
  const source: Record<string, unknown> = { ...value };
  return {
    sponsor: readBool(source.sponsor, DEFAULT_SETTINGS.categories.sponsor),
    selfpromo: readBool(source.selfpromo, DEFAULT_SETTINGS.categories.selfpromo),
  };
}

export async function load(): Promise<Settings> {
  const raw = await chrome.storage.sync.get(null);
  return {
    enabled: readBool(raw.enabled, DEFAULT_SETTINGS.enabled),
    autoSkip: readBool(raw.autoSkip, DEFAULT_SETTINGS.autoSkip),
    showPreviewBar: readBool(raw.showPreviewBar, DEFAULT_SETTINGS.showPreviewBar),
    noticeDuration:
      typeof raw.noticeDuration === "number" && raw.noticeDuration >= 0
        ? raw.noticeDuration
        : DEFAULT_SETTINGS.noticeDuration,
    edgeSensitivity:
      raw.edgeSensitivity === "conservative" || raw.edgeSensitivity === "eager"
        ? raw.edgeSensitivity
        : "balanced",
    model: raw.model === "large" ? "large" : "base",
    categories: readCategories(raw.categories),
  };
}

export async function save(patch: Partial<Settings>): Promise<void> {
  // chrome.storage.set wants an index-signature type; Partial<Settings> is
  // structurally compatible but TypeScript will not unify the two.
  const items: Record<string, unknown> = { ...patch };
  await chrome.storage.sync.set(items);
}

/** Fires whenever any setting changes, in any context. */
export function onChange(handler: (settings: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    void load().then(handler);
  });
}
