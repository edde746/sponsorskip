/**
 * Manual skip button in the player control bar.
 *
 * Only relevant when auto-skip is off, which is a real preference: some people
 * want to see what the sponsor is before deciding. Mounts next to YouTube's
 * chapter container, matching where SponsorBlock puts its own button, because
 * that is the spot users already look.
 */
import { findControlBar } from "../dom";
import type { Segment } from "../../shared/types";

export class SkipButton {
  private root: HTMLButtonElement | null = null;
  private parent: HTMLElement | null = null;
  private segment: Segment | null = null;

  constructor(private readonly onSkip: (segment: Segment) => void) {}

  /** Show the button for `segment`, or hide it when null. */
  update(segment: Segment | null): void {
    if (!segment) {
      this.hide();
      return;
    }

    const bar = findControlBar();
    if (!bar) return;

    if (!this.root || this.parent !== bar) {
      this.root?.remove();
      this.parent = bar;
      this.root = document.createElement("button");
      this.root.className = "sponsorskip-skip-button";
      this.root.addEventListener("click", () => {
        if (this.segment) this.onSkip(this.segment);
        this.hide();
      });
      bar.insertAdjacentElement("afterend", this.root);
    }

    this.segment = segment;
    this.root.textContent =
      segment.category === "sponsor" ? "Skip sponsor \u00bb" : "Skip self-promo \u00bb";
    this.root.hidden = false;
  }

  hide(): void {
    this.segment = null;
    if (this.root) this.root.hidden = true;
  }

  remove(): void {
    this.root?.remove();
    this.root = null;
    this.parent = null;
    this.segment = null;
  }
}
