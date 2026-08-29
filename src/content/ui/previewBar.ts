/**
 * Segment overlay on the video progress bar.
 *
 * Written from scratch rather than adapted from SponsorBlock's `previewBar.ts`:
 * that file is 1195 lines because it also does chapters, scrub tooltips, vote
 * widgets, YouTube TV and Vorapis quirks, and it is welded to their `Config`
 * singleton and `SponsorTime` type. A sponsor-only overlay is this much code.
 *
 * The one thing genuinely worth taking from them is the attach-point selector
 * table, which lives in `../dom.ts` with attribution.
 */
import { findProgressBar } from "../dom";
import type { Category, Segment } from "../../shared/types";

/** SponsorBlock's established category colours; users recognise them. */
const COLORS: Record<Category, string> = {
  sponsor: "#00d400",
  selfpromo: "#ffff00",
};

export class PreviewBar {
  private container: HTMLElement | null = null;
  private parent: HTMLElement | null = null;

  /**
   * Ensure the overlay exists and is parented to the live progress bar.
   *
   * Called on every update because YouTube rebuilds the progress bar on
   * fullscreen, theatre and miniplayer transitions, which silently orphans a
   * previously attached overlay.
   */
  private ensure(): HTMLElement | null {
    const bar = findProgressBar();
    if (!bar) return null;

    if (this.container && this.parent === bar) return this.container;

    this.container?.remove();
    this.parent = bar;
    this.container = document.createElement("div");
    this.container.className = "sponsorskip-preview-bar";
    bar.appendChild(this.container);
    return this.container;
  }

  update(segments: Segment[], duration: number): void {
    const container = this.ensure();
    if (!container) return;

    container.replaceChildren();
    if (!Number.isFinite(duration) || duration <= 0) return;

    for (const segment of segments) {
      const start = Math.max(0, Math.min(segment.start, duration));
      const end = Math.max(start, Math.min(segment.end, duration));
      const mark = document.createElement("div");
      mark.className = "sponsorskip-preview-segment";
      mark.style.left = `${(start / duration) * 100}%`;
      mark.style.width = `${((end - start) / duration) * 100}%`;
      mark.style.backgroundColor = COLORS[segment.category];
      mark.title =
        segment.score === undefined
          ? segment.category
          : `${segment.category} (${Math.round(segment.score * 100)}% confident)`;
      container.appendChild(mark);
    }
  }

  clear(): void {
    this.container?.replaceChildren();
  }

  remove(): void {
    this.container?.remove();
    this.container = null;
    this.parent = null;
  }
}
