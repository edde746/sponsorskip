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
   * Decision threshold override. Null means use the model's own tuned value,
   * which is the calibrated default; raising it trades recall for precision.
   */
  thresholdOverride: number | null;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  autoSkip: true,
  categories: { sponsor: true, selfpromo: true },
  noticeDuration: 6,
  showPreviewBar: true,
  thresholdOverride: null,
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
    thresholdOverride:
      typeof raw.thresholdOverride === "number" ? raw.thresholdOverride : null,
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
