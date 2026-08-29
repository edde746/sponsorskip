/**
 * YouTube DOM knowledge.
 *
 * The progress-bar selector table below is adapted from SponsorBlock
 * (`src/content.ts::getPreviewBarAttachElement`), GPL-3.0, (c) Ajay Ramachandran
 * and contributors. It is the highest value-per-line thing in that project: an
 * ordered, visibility-checked list of every progress-bar shape YouTube and its
 * front-ends have shipped. Reproducing it by trial and error would take weeks.
 *
 * Order is significant, not cosmetic. The hover-preview bar must win over the
 * main bar so the miniplayer-plus-hover-preview case attaches to the right one.
 */

/** Laid out and painted, i.e. a real candidate rather than a hidden template. */
export function isVisible(element: HTMLElement | null): boolean {
  return (
    !!element &&
    element.offsetWidth > 0 &&
    element.offsetHeight > 0 &&
    element.getClientRects().length > 0
  );
}

interface ProgressBarOption {
  selector: string;
  /** Some front-ends keep the bar zero-sized until playback starts. */
  visibleCheck?: boolean;
}

const PROGRESS_BAR_OPTIONS: ProgressBarOption[] = [
  // Newer mobile YouTube (Sept 2024)
  {
    selector:
      ".ytChapteredProgressBarHost, .ytProgressBarLineHost, .YtProgressBarLineHost, .YtChapteredProgressBarHost",
    visibleCheck: true,
  },
  // Newer mobile YouTube (May 2024)
  { selector: ".YtmProgressBarProgressBarLine", visibleCheck: true },
  // Desktop hover play. Must outrank the main bar; see the file comment.
  {
    selector: "#video-preview .ytp-progress-bar, #video-preview .YtProgressBarLineHost",
    visibleCheck: true,
  },
  // Desktop YouTube
  { selector: ".ytp-progress-bar", visibleCheck: true },
  { selector: ".no-model.cue-range-marker", visibleCheck: true },
  // Invidious / VideoJS
  { selector: ".vjs-progress-holder", visibleCheck: false },
  // YouTube Music and YTKids. Two sliders share #progressContainer (volume and
  // progress), so this path must stay specific.
  { selector: "#progress-bar>#sliderContainer>div>#sliderBar>#progressContainer" },
  // piped
  { selector: ".shaka-ad-markers", visibleCheck: false },
  // Vorapis v3
  { selector: ".ytp-progress-bar-container > .html5-progress-bar > .ytp-progress-list" },
  // YouTube TV
  { selector: ".yssi-slider > div.ytu-ss-timeline-container", visibleCheck: false },
];

/** The element our segment overlay should be parented to, if one exists yet. */
export function findProgressBar(): HTMLElement | null {
  for (const option of PROGRESS_BAR_OPTIONS) {
    const all = document.querySelectorAll<HTMLElement>(option.selector);
    if (option.visibleCheck) {
      for (const el of all) if (isVisible(el)) return el;
    } else if (all[0]) {
      return all[0];
    }
  }
  return null;
}

/** Where the manual-skip button mounts, next to YouTube's own controls. */
export function findControlBar(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    ".ytp-chapter-container, .ytp-left-controls",
  );
}

/**
 * True while YouTube is playing an ad in the main player.
 *
 * This matters more than it looks. During an ad break the `<video>` element is
 * reused but reports the AD's `duration` and `currentTime`, so every segment
 * timestamp we hold is meaningless: a preview bar drawn then puts a 35s segment
 * at 100% of a 6s ad, and a skip scheduled then would seek inside the ad.
 */
export function isAdShowing(): boolean {
  const player = document.querySelector("#movie_player");
  return !!player?.classList.contains("ad-showing");
}
