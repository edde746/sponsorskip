/**
 * Video element discovery and YouTube SPA navigation.
 *
 * Mechanism re-derived from SponsorBlock's `maze-utils/src/video.ts` (GPL-3.0),
 * which is the load-bearing lesson of that project: neither "find the video
 * once" nor "listen for navigation" is sufficient on its own, because YouTube
 * reuses one `<video>` across navigations but also silently replaces it when
 * the player is rebuilt for theatre mode, the miniplayer, or an ad break.
 *
 * So this watches four things, each covering a case the others miss:
 *  - `yt-navigate-finish` / `yt-page-data-updated`: ordinary in-app navigation.
 *  - The Navigation API, where available: history changes that fire no yt event.
 *  - A throttled MutationObserver: player rebuilds that fire no event at all.
 *  - Visibility: a detached-but-present `<video>` must be treated as absent,
 *    otherwise we bind to a hidden element and never see playback.
 */
import { isVisible } from "./dom";

/**
 * Callbacks are split because the two facts arrive independently and are needed
 * for different things.
 *
 * The video id is all detection needs, and it is known the moment the URL is.
 * The `<video>` element is needed only to seek and to read duration, and it can
 * appear seconds later, be replaced on a player rebuild, or -- on a browser
 * that cannot decode YouTube's media at all -- never usefully appear.
 *
 * Gating detection on the element, as an earlier version of this did, means a
 * slow or broken player silently suppresses detection entirely. Splitting them
 * also lets inference overlap player initialisation, so segments are ready
 * sooner in the normal case.
 */
export interface WatcherHandlers {
  /** A different video is now showing. Fires before any element exists. */
  onVideoId: (videoId: string) => void;
  /** The player's media element appeared or was swapped out. */
  onVideoElement: (video: HTMLVideoElement) => void;
  /** No video page any more. */
  onGone: () => void;
}

/** Mutation storms are constant on YouTube; do not re-query on every record. */
const MUTATION_THROTTLE_MS = 2000;
/** Backstop for history manipulation that fires neither event source. */
const POLL_INTERVAL_MS = 1000;

/** Extract the watch id from a URL. Returns null when not on a video page. */
export function videoIdFromLocation(): string | null {
  const url = new URL(location.href);
  if (url.pathname === "/watch") return url.searchParams.get("v");
  const m = /^\/(?:shorts|embed)\/([\w-]{11})/.exec(url.pathname);
  return m ? m[1] : null;
}

export class PlayerWatcher {
  private currentId: string | null = null;
  private currentVideo: HTMLVideoElement | null = null;
  private observer: MutationObserver | null = null;
  private pollTimer: number | null = null;
  private lastMutationCheck = 0;

  constructor(private readonly handlers: WatcherHandlers) {}

  start(): void {
    document.addEventListener("yt-navigate-finish", this.check);
    document.addEventListener("yt-page-data-updated", this.check);

    if ("navigation" in window) {
      (window.navigation as EventTarget).addEventListener("navigate", this.check);
    }

    this.observer = new MutationObserver(this.onMutation);
    // `documentElement`, not `body`: this content script runs at
    // `document_start`, where `document.body` is still null. Observing it there
    // throws, and because `start()` is reached from an async settings load the
    // throw surfaces only as an unhandled rejection -- the watcher silently
    // never starts, and whether it happens at all is a parse-timing race.
    this.observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
    });

    this.pollTimer = window.setInterval(this.check, POLL_INTERVAL_MS);
    this.check();
  }

  stop(): void {
    document.removeEventListener("yt-navigate-finish", this.check);
    document.removeEventListener("yt-page-data-updated", this.check);
    if ("navigation" in window) {
      (window.navigation as EventTarget).removeEventListener("navigate", this.check);
    }
    this.observer?.disconnect();
    this.observer = null;
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /**
   * Arrow properties, not methods: these are registered as listeners in several
   * places and must keep a stable identity for removeEventListener.
   */
  private onMutation = (): void => {
    const now = performance.now();
    if (now - this.lastMutationCheck < MUTATION_THROTTLE_MS) return;
    this.lastMutationCheck = now;
    this.check();
  };

  private check = (): void => {
    const id = videoIdFromLocation();
    if (!id) {
      if (this.currentId !== null || this.currentVideo !== null) {
        this.currentId = null;
        this.currentVideo = null;
        this.handlers.onGone();
      }
      return;
    }

    // Report the id first: detection can start while the player is still
    // building itself.
    if (id !== this.currentId) {
      this.currentId = id;
      this.currentVideo = null;
      this.handlers.onVideoId(id);
    }

    // Scope to the real player: a bare `video` selector also matches inline
    // preview players on the homepage and in the sidebar.
    const found = document.querySelector<HTMLVideoElement>(
      "#movie_player video, ytd-player video",
    );
    const video = isVisible(found) ? found : null;
    if (video && video !== this.currentVideo) {
      this.currentVideo = video;
      this.handlers.onVideoElement(video);
    }
  };
}
