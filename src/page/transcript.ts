/**
 * Transcript acquisition, client-side.
 *
 * This MUST run in the content script, not the service worker. Measured, on
 * the same video, in the same browser, seconds apart:
 *
 *   page context (https://www.youtube.com)  -> HTTP 200, 4065 words
 *   service worker (chrome-extension://...) -> HTTP 403, HTML error body
 *
 * InnerTube rejects the extension origin. A service-worker fetch would have
 * been tidier -- no page CSP, no CORS question -- but it simply does not work,
 * so the fetch lives here where the origin is YouTube's own.
 *
 * Everything else about the design follows from that: the request goes out over
 * the user's own IP with the user's own cookies, which is the whole reason this
 * extension needs no backend. Centralised bulk fetching is what gets an IP
 * blocked, and that lesson is why nothing here is batched or proxied.
 *
 * The call uses the keyless `IOS` client context, which needs no API key and no
 * PoToken for the captions tracklist. A normal browser User-Agent is accepted
 * (verified: HTTP 200 with both `manual` and `asr` English tracks), so there is
 * no need to rewrite the UA via declarativeNetRequest.
 */
import type { Unavailable, Word } from "../shared/types";

const PLAYER_URL = "https://www.youtube.com/youtubei/v1/player";
const IOS_CONTEXT = {
  client: {
    clientName: "IOS",
    clientVersion: "20.10.4",
    deviceMake: "Apple",
    deviceModel: "iPhone16,2",
    osName: "iPhone",
    osVersion: "18.3.2.22D82",
    hl: "en",
    gl: "US",
  },
};

/** Below this the transcript is not worth a model pass. Matches training. */
const MIN_WORDS = 50;

interface CaptionTrack {
  baseUrl: string;
  languageCode?: string;
  kind?: string;
}

interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Seg[];
}

export interface TranscriptResult {
  words?: Word[];
  duration?: number;
  /** Which track we used, for diagnostics: ASR is the training distribution. */
  kind?: string;
  error?: Unavailable;
}

/**
 * json3 -> word stream with genuine per-word timing.
 *
 * Port of `fetch_transcripts.py::parse_words`, and it must stay a port: this is
 * the exact preprocessing the model was trained on.
 *
 * ASR tracks give one seg per word carrying `tOffsetMs`. Manual tracks pack a
 * whole line into one seg with no offsets, which would otherwise produce
 * multi-word "words" sharing a timestamp and destroy word-level alignment, so
 * those get split on whitespace and interpolated across the piece's interval.
 */
export function parseWords(events: Json3Event[]): Word[] {
  const words: Word[] = [];
  for (const e of events) {
    if (!e.segs?.length) continue;
    const base = e.tStartMs ?? 0;
    const eEnd = base + (e.dDurationMs ?? 0);

    const pieces: Array<[string, number]> = [];
    for (const s of e.segs) {
      const t = s.utf8 ?? "";
      if (!t.trim()) continue;
      pieces.push([t.trim(), base + (s.tOffsetMs ?? 0)]);
    }

    for (let i = 0; i < pieces.length; i++) {
      const [txt, t0] = pieces[i];
      const t1 = i + 1 < pieces.length ? pieces[i + 1][1] : Math.max(eEnd, t0);
      const toks = txt.split(/\s+/).filter(Boolean);
      if (toks.length <= 1) {
        if (toks.length === 1) words.push([toks[0], t0]);
        continue;
      }
      const span = Math.max(0, t1 - t0);
      for (let k = 0; k < toks.length; k++) {
        // Integer division, matching Python's `//`.
        words.push([toks[k], t0 + Math.floor((span * k) / toks.length)]);
      }
    }
  }
  return words;
}

/** Fetch the word-level transcript for a video, or say why we cannot. */
export async function fetchTranscript(videoId: string): Promise<TranscriptResult> {
  let player: {
    playabilityStatus?: { status?: string };
    videoDetails?: { lengthSeconds?: string };
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } };
  };
  try {
    const res = await fetch(PLAYER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId,
        context: IOS_CONTEXT,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });
    if (!res.ok) return { error: "fetch_failed" };
    player = await res.json();
  } catch {
    return { error: "fetch_failed" };
  }

  const status = player.playabilityStatus?.status;
  if (status && status !== "OK") return { error: "fetch_failed" };

  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const en = tracks.filter((t) => (t.languageCode ?? "").startsWith("en"));
  if (en.length === 0) return { error: "no_captions" };

  // Prefer ASR: it carries per-word tOffsetMs, and it is what most videos have
  // at inference time, so train/serve preprocessing stays identical.
  en.sort((a, b) => Number(a.kind !== "asr") - Number(b.kind !== "asr"));

  let words: Word[];
  try {
    const raw = await fetch(`${en[0].baseUrl}&fmt=json3`);
    if (!raw.ok) return { error: "fetch_failed" };
    const j3: unknown = await raw.json();
    const events = j3 && typeof j3 === "object" && "events" in j3 ? j3.events : null;
    words = parseWords(Array.isArray(events) ? events : []);
  } catch {
    return { error: "fetch_failed" };
  }

  if (words.length < MIN_WORDS) return { error: "too_short" };
  return {
    words,
    duration: Number(player.videoDetails?.lengthSeconds ?? 0),
    kind: en[0].kind ?? "manual",
  };
}
