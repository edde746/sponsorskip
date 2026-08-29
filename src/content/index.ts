/**
 * Content script: the orchestrator.
 *
 * Owns no detection logic and no DOM knowledge of its own. It wires the
 * collaborators together and holds the only state that spans them: which video
 * is showing, which element is playing it, and which segments we believe it has.
 *
 * Detection and playback are deliberately independent. Segments are fetched as
 * soon as the video id is known; the player element is wired up whenever it
 * turns up. Neither waits for the other.
 */
import { PlayerWatcher, videoIdFromLocation } from "./player";
import { requestTranscript } from "./transcriptBridge";
import { Skipper, type SkipEvent } from "./skipper";
import { isAdShowing } from "./dom";
import { PreviewBar } from "./ui/previewBar";
import { SkipNotice } from "./ui/notice";
import { SkipButton } from "./ui/skipButton";
import * as settings from "../shared/settings";
import type { SegmentsResponse } from "../shared/messages";
import type { Segment } from "../shared/types";

/** How often to refresh the manual-skip button while auto-skip is off. */
const MANUAL_POLL_MS = 250;

let config = settings.DEFAULT_SETTINGS;
/** Everything the model returned for the current video, before filtering. */
let allSegments: Segment[] = [];
let currentVideoId: string | null = null;
let currentVideo: HTMLVideoElement | null = null;
let manualTimer: number | null = null;

const previewBar = new PreviewBar();
const notice = new SkipNotice();

const skipper = new Skipper(
  (event: SkipEvent) => {
    if (!config.autoSkip) return;
    notice.show({
      segment: event.segment,
      duration: config.noticeDuration,
      onUnskip: () => skipper.unskip(event.segment),
    });
  },
  isAdShowing,
);

const skipButton = new SkipButton((segment) => skipper.skipNow(segment));

/** Segments the user's category preferences actually permit acting on. */
function activeSegments(): Segment[] {
  if (!config.enabled) return [];
  return allSegments.filter((s) => config.categories[s.category]);
}

function render(): void {
  const active = activeSegments();

  // An ad break makes `duration` the ad's, not the video's, so anything drawn
  // from it would be nonsense. Wait for the real timeline to come back.
  const drawable =
    config.showPreviewBar &&
    currentVideo !== null &&
    !isAdShowing() &&
    Number.isFinite(currentVideo.duration) &&
    currentVideo.duration > 0;
  if (drawable && currentVideo) previewBar.update(active, currentVideo.duration);
  else previewBar.clear();

  if (currentVideoId) skipper.setSegments(config.autoSkip ? active : [], currentVideoId);

  if (manualTimer !== null) window.clearInterval(manualTimer);
  manualTimer = null;
  if (config.enabled && !config.autoSkip && active.length > 0) {
    manualTimer = window.setInterval(() => {
      skipButton.update(skipper.segmentAt(skipper.currentTime()));
    }, MANUAL_POLL_MS);
  } else {
    skipButton.hide();
  }
}

/** Fetch or recall this video's segments. Does not touch the player. */
async function detect(videoId: string): Promise<void> {
  try {
    // Step 1: ask before fetching, so a cached video costs no network at all.
    const known: SegmentsResponse = await chrome.runtime.sendMessage({
      type: "REQUEST_SEGMENTS",
      videoId,
    });
    if (videoId !== currentVideoId) return;

    if (known.status !== "need_transcript") {
      allSegments = known.segments ?? [];
      render();
      return;
    }

    // Step 2: delegate to the main world, the only context whose fetch origin
    // InnerTube accepts. See ../shared/bridge.ts.
    const transcript = await requestTranscript(videoId);
    if (videoId !== currentVideoId) return;

    if (!transcript.words) {
      // Named out loud: "it silently does nothing" is the worst failure mode,
      // and this is the line that tells a user which case they hit.
      console.info(`[sponsorskip] no transcript for ${videoId}: ${transcript.error}`);
      void chrome.runtime.sendMessage({
        type: "REPORT_UNAVAILABLE",
        videoId,
        reason: transcript.error,
      });
      return;
    }

    const detected: SegmentsResponse = await chrome.runtime.sendMessage({
      type: "SUBMIT_TRANSCRIPT",
      videoId,
      words: transcript.words,
    });
    // The user may have navigated on while inference ran.
    if (videoId !== currentVideoId) return;

    allSegments = detected.segments ?? [];
    render();
  } catch (err) {
    console.warn("[sponsorskip] detection unavailable", err);
  }
}

const watcher = new PlayerWatcher({
  onVideoId: (videoId) => {
    currentVideoId = videoId;
    currentVideo = null;
    allSegments = [];
    notice.dismiss();
    skipButton.hide();
    previewBar.clear();
    skipper.detach();
    void detect(videoId);
  },

  onVideoElement: (video) => {
    if (!currentVideoId) return;
    currentVideo = video;
    skipper.attach(video, currentVideoId);
    // Not `once`: duration changes again at every ad boundary, and each change
    // is a chance to draw the bar correctly (or to stop drawing it wrongly).
    video.addEventListener("durationchange", render);
    video.addEventListener("loadedmetadata", render);
    render();
  },

  onGone: () => {
    currentVideoId = null;
    currentVideo = null;
    allSegments = [];
    skipper.detach();
    notice.dismiss();
    skipButton.remove();
    previewBar.remove();
    if (manualTimer !== null) window.clearInterval(manualTimer);
    manualTimer = null;
  },
});

// A throw in here used to vanish as an unhandled rejection and leave the
// extension inert with no diagnostic. Never let startup fail quietly.
void settings.load().then(
  (loaded) => {
    config = loaded;
    watcher.start();
  },
  (err) => console.error("[sponsorskip] failed to start", err),
);

settings.onChange((updated) => {
  config = updated;
  // A category or auto-skip change must take effect without a reload, and it
  // must not re-run inference: `allSegments` is already the unfiltered truth.
  if (videoIdFromLocation() === currentVideoId) render();
});
