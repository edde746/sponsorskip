/**
 * Skip scheduling.
 *
 * Algorithm re-derived from SponsorBlock's approach, which is the right one and
 * worth stating plainly: never poll `currentTime` in a loop. Compute the next
 * boundary once, arm a single timer, and cancel-and-re-arm on every event that
 * could invalidate it (play, pause, seek, rate change, buffering, new segments).
 *
 * Three details make it frame-accurate rather than approximately right:
 *
 *  1. `HTMLMediaElement.currentTime` is coarse -- browsers quantise it, Firefox
 *     deliberately so for fingerprinting resistance. So near a boundary we stop
 *     trusting it and read a virtual clock derived from `performance.now()`.
 *  2. `setTimeout` cannot be trusted for the final stretch either, so the last
 *     ~250 ms escalates to a zero-delay interval that busy-checks the clock.
 *  3. A timer armed before an SPA navigation can fire afterwards. Every callback
 *     re-validates the video id before seeking, or it would seek a video the
 *     user has already navigated away from.
 */
import { videoIdFromLocation } from "./player";
import type { Segment } from "../shared/types";

/** Treat "within 3 ms of the boundary" as arrived. */
const SKIP_BUFFER_S = 0.003;
/** Do not bother skipping a segment that is nearly over anyway. */
const END_BUFFER_S = 0.5;
/** Below this remaining delay, switch from setTimeout to a busy interval. */
const BUSY_THRESHOLD_MS = 250;
/** Reject the virtual clock if it leads the reported time by more than this. */
const VIRTUAL_TRUST_S = 0.8;

export interface SkipEvent {
  segment: Segment;
  /** True when we seeked; false when we only surfaced a manual-skip offer. */
  skipped: boolean;
}

/** Stable identity for a segment, so opt-outs survive rescheduling. */
export function segmentKey(s: Segment): string {
  return `${s.category}:${s.start.toFixed(3)}:${s.end.toFixed(3)}`;
}

export class Skipper {
  private video: HTMLVideoElement | null = null;
  private videoId: string | null = null;
  private segments: Segment[] = [];

  private timer: number | null = null;
  private busy: number | null = null;

  /** Anchor for the virtual clock, refreshed on play/playing/ratechange. */
  private anchor: { videoTime: number; preciseTime: number } | null = null;

  /** Segments the user opted out of. Never auto-skipped again this session. */
  private readonly optedOut = new Set<string>();
  /** Segments already auto-skipped, so a seek back does not re-trigger. */
  private readonly acted = new Set<string>();

  /**
   * @param onSkip fired after a successful seek.
   * @param isSuspended when true, scheduling is inhibited. Injected rather than
   *   reaching for the DOM here, so this class stays free of YouTube specifics.
   *   Used for ad breaks, during which our timestamps refer to a different
   *   timeline entirely.
   */
  constructor(
    private readonly onSkip: (event: SkipEvent) => void,
    private readonly isSuspended: () => boolean = () => false,
  ) {}

  attach(video: HTMLVideoElement, videoId: string): void {
    if (this.video === video && this.videoId === videoId) return;
    this.detach();

    this.video = video;
    this.videoId = videoId;
    this.segments = [];
    this.acted.clear();
    this.optedOut.clear();

    for (const [event, handler] of this.listeners()) {
      video.addEventListener(event, handler);
    }
    this.refreshAnchor();
    this.schedule();
  }

  detach(): void {
    this.cancel();
    if (this.video) {
      for (const [event, handler] of this.listeners()) {
        this.video.removeEventListener(event, handler);
      }
    }
    this.video = null;
    this.videoId = null;
    this.anchor = null;
  }

  setSegments(segments: Segment[], videoId: string): void {
    // A late result for a video the user already left must not arm anything.
    if (videoId !== this.videoId) return;
    this.segments = [...segments].sort((a, b) => a.start - b.start);
    this.schedule();
  }

  /** User pressed "unskip": seek back and never auto-skip this span again. */
  unskip(segment: Segment): void {
    if (!this.video) return;
    this.optedOut.add(segmentKey(segment));
    this.video.currentTime = segment.start;
    this.refreshAnchor();
    this.schedule();
  }

  /** User pressed the manual skip button. */
  skipNow(segment: Segment): void {
    this.performSkip(segment);
  }

  /** Segment containing a time, if any. Drives the manual-skip button state. */
  segmentAt(time: number): Segment | null {
    return (
      this.segments.find(
        (s) => time >= s.start - SKIP_BUFFER_S && time < s.end - END_BUFFER_S,
      ) ?? null
    );
  }

  private listeners(): Array<[string, () => void]> {
    return [
      ["play", this.onPlay],
      ["playing", this.onPlay],
      ["pause", this.onPause],
      ["seeked", this.onSeeked],
      ["seeking", this.onSeeking],
      ["ratechange", this.onRateChange],
      ["waiting", this.onSeeking],
      ["durationchange", this.onRateChange],
    ];
  }

  private onPlay = (): void => {
    this.refreshAnchor();
    this.schedule();
  };

  private onPause = (): void => {
    this.anchor = null;
    this.cancel();
  };

  private onSeeking = (): void => {
    this.anchor = null;
    this.cancel();
  };

  private onSeeked = (): void => {
    this.refreshAnchor();
    this.schedule();
  };

  private onRateChange = (): void => {
    this.refreshAnchor();
    this.schedule();
  };

  private refreshAnchor(): void {
    if (!this.video || this.video.paused) {
      this.anchor = null;
      return;
    }
    this.anchor = {
      videoTime: this.video.currentTime,
      preciseTime: performance.now(),
    };
  }

  /**
   * Best available playback position.
   *
   * Extrapolates from the anchor when that leads the reported time by a
   * plausible margin. The margin check is what keeps this safe: if the video
   * stalls, the extrapolation runs away and gets rejected, and we fall back to
   * the browser's own value.
   */
  currentTime(): number {
    const video = this.video;
    if (!video) return 0;
    const reported = video.currentTime;
    if (!this.anchor || video.paused) return reported;

    const elapsed = (performance.now() - this.anchor.preciseTime) / 1000;
    const extrapolated = this.anchor.videoTime + elapsed * video.playbackRate;
    const lead = extrapolated - reported;
    if (lead > 0 && lead < VIRTUAL_TRUST_S) return extrapolated;
    return reported;
  }

  private cancel(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.busy !== null) window.clearInterval(this.busy);
    this.timer = null;
    this.busy = null;
  }

  /** The next segment worth acting on at or after `from`. */
  private nextSegment(from: number): Segment | null {
    for (const s of this.segments) {
      if (this.optedOut.has(segmentKey(s))) continue;
      if (s.end - END_BUFFER_S <= from) continue;
      return s;
    }
    return null;
  }

  private schedule(): void {
    this.cancel();
    const video = this.video;
    if (!video || video.paused || this.segments.length === 0) return;
    if (this.isSuspended()) return;

    const now = this.currentTime();
    const segment = this.nextSegment(now);
    if (!segment) return;

    // Already inside it. Skip at once unless we already acted and the user
    // deliberately came back, which `acted` distinguishes from a fresh entry.
    if (now >= segment.start - SKIP_BUFFER_S) {
      if (this.acted.has(segmentKey(segment))) return;
      this.performSkip(segment);
      return;
    }

    const delayMs = ((segment.start - now) * 1000) / video.playbackRate;
    if (delayMs > BUSY_THRESHOLD_MS) {
      this.timer = window.setTimeout(
        () => this.startBusy(segment),
        delayMs - BUSY_THRESHOLD_MS,
      );
    } else {
      this.startBusy(segment);
    }
  }

  /**
   * Final approach: zero-delay interval checking the virtual clock.
   *
   * This is the part that buys frame accuracy. It runs for at most
   * BUSY_THRESHOLD_MS of playback, so the cost is negligible.
   */
  private startBusy(segment: Segment): void {
    this.cancel();
    const video = this.video;
    if (!video) return;

    this.busy = window.setInterval(() => {
      if (!this.video || this.video.paused) {
        this.cancel();
        return;
      }
      if (this.currentTime() + SKIP_BUFFER_S >= segment.start) {
        this.performSkip(segment);
      }
    }, 0);
  }

  private performSkip(segment: Segment): void {
    this.cancel();
    const video = this.video;
    if (!video) return;

    // A timer armed before an SPA navigation can still fire. Seeking now would
    // mutilate whatever the user is watching instead.
    if (videoIdFromLocation() !== this.videoId) return;

    const key = segmentKey(segment);
    if (this.acted.has(key) || this.optedOut.has(key)) return;
    this.acted.add(key);

    const duration = video.duration;
    let target = segment.end;
    if (Number.isFinite(duration) && target >= duration) {
      // Seeking exactly to duration ends or loops the video depending on
      // platform; step just short of it instead.
      target = Math.max(0, duration - 0.001);
    }
    video.currentTime = target;

    this.refreshAnchor();
    this.onSkip({ segment, skipped: true });

    // Chained or overlapping segments resolve by re-entering from the new time
    // rather than by looping over the list here.
    this.schedule();
  }
}
