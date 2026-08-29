/**
 * "Skipped a sponsor" toast, with unskip.
 *
 * Deliberately not adapted from SponsorBlock's `SkipNoticeComponent` (854 lines
 * of React): roughly 70% of that component is segment voting, category
 * re-selection, submission editing and clipboard export, all of which exist to
 * serve a crowd-sourced database. This extension has no server to vote against,
 * so the honest version is a toast with one action.
 *
 * Plain DOM, which drops React and react-dom from the bundle entirely.
 */
import type { Segment } from "../../shared/types";

export interface NoticeOptions {
  segment: Segment;
  /** Seconds before auto-dismiss. Countdown pauses while hovered. */
  duration: number;
  onUnskip: () => void;
}

export class SkipNotice {
  private root: HTMLElement | null = null;
  private timer: number | null = null;
  private remaining = 0;
  private hovered = false;

  /** Mounts inside the player so it survives fullscreen. */
  show({ segment, duration, onUnskip }: NoticeOptions): void {
    this.dismiss();
    if (duration <= 0) return;

    const player = document.querySelector<HTMLElement>("#movie_player");
    if (!player) return;

    this.root = document.createElement("div");
    this.root.className = "sponsorskip-notice";

    const label = document.createElement("span");
    label.className = "sponsorskip-notice-label";
    label.textContent = segment.category === "sponsor" ? "Skipped sponsor" : "Skipped self-promo";

    const countdown = document.createElement("span");
    countdown.className = "sponsorskip-notice-countdown";

    const unskip = document.createElement("button");
    unskip.className = "sponsorskip-notice-button";
    unskip.textContent = "Unskip";
    unskip.addEventListener("click", () => {
      onUnskip();
      this.dismiss();
    });

    const close = document.createElement("button");
    close.className = "sponsorskip-notice-close";
    close.textContent = "\u00d7";
    close.setAttribute("aria-label", "Dismiss");
    close.addEventListener("click", () => this.dismiss());

    this.root.append(label, unskip, countdown, close);

    // Hovering must not steal the countdown: users reach for "Unskip" late.
    this.root.addEventListener("mouseenter", () => {
      this.hovered = true;
    });
    this.root.addEventListener("mouseleave", () => {
      this.hovered = false;
    });

    player.appendChild(this.root);

    this.remaining = duration;
    countdown.textContent = String(Math.ceil(this.remaining));
    this.timer = window.setInterval(() => {
      if (this.hovered) return;
      this.remaining -= 0.25;
      countdown.textContent = String(Math.max(0, Math.ceil(this.remaining)));
      if (this.remaining <= 0) this.dismiss();
    }, 250);
  }

  dismiss(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.root?.remove();
    this.root = null;
    this.hovered = false;
  }
}
