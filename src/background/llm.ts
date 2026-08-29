/**
 * LLM detection against any OpenAI-compatible chat endpoint.
 *
 * The prompt, the 10-second transcript chunking and the JSON recovery are ports
 * of the benchmarked research pipeline, not fresh guesses. They were selected
 * over 749 calls across candidate models, and the details earn their keep:
 *
 *  - **10-second lines.** The window sets a hard floor on boundary precision,
 *    because a model can only cite a line's start time. At 20 s boundaries
 *    quantise by ~10.6 s on average; at 10 s, ~4.6 s. Going to 5 s buys ~1.0 s
 *    for ~9% more prompt tokens.
 *  - **The short-segment sweep.** Without it, models miss 1-5 s pre-roll tags
 *    and one-sentence outro callbacks almost entirely.
 *  - **Balanced-brace recovery.** Models wrap JSON in fences, prose and
 *    `<think>` blocks; a naive `JSON.parse` of the whole reply fails constantly.
 *
 * Measured on the 93-video hand-labelled set: F1 0.821, precision 0.923,
 * recall 0.740, boundary error 3.14 s, about $0.00085 per video. Note the shape
 * of that result -- an LLM is markedly more precise and markedly less complete
 * than the local model, so it is offered as an alternative, not an upgrade.
 */
import type { Category, Segment, Word } from "../shared/types";

const SYSTEM = `You detect sponsor/advertisement segments in YouTube transcripts.

A SPONSOR segment is a paid promotional read for a product, service, or brand.
Hallmarks: a named advertiser, a call to action, a URL, a promo/discount code,
or a pivot phrase like "this episode is brought to you by" / "first though, I
want to tell you about X".

NOT sponsors (never report these):
- The creator's own content, opinions, news reads, interviews, clips.
- Self-promotion with no external advertiser (asking for likes/subscribes,
  the channel's own merch or membership).
- Casual gratitude or venue/host credits with no product pitch, no URL and no code.
- Editorial mentions of a company that are not a paid read.

Boundaries: \`start\` is where the host pivots INTO the ad (include the pivot
sentence, e.g. "first though, I want to tell you about..."). \`end\` is where
editorial content resumes. Do not swallow the content sentence before the pivot,
and do not leave ad audio outside the segment.

Return ONLY a JSON object, no prose, no markdown fence:
{"segments":[{"brand":"<advertiser>","start":<seconds>,"end":<seconds>}]}
\`start\`/\`end\` are floats in SECONDS from the video start. If there are no
sponsors, return {"segments":[]}.

CRITICAL - short segments are easy to miss. Sweep for these explicitly:
1. PRE-ROLL ATTRIBUTION. Videos often open with a 1-5 second sponsor tag before any
   content, e.g. "Sponsored by <brand>", "This video is made possible by <brand>",
   "Today's video is brought to you by <brand>". These ARE sponsor segments even
   though they are only a few seconds long. Check the very first lines of every
   transcript.
2. OUTRO CALLBACK. Near the end, hosts often re-plug the same advertiser in one
   sentence, e.g. "don't forget to check out <brand>, link in the description".
   This IS a sponsor segment, separate from the main read. Check the last lines.
3. The same advertiser can therefore appear 2-3 times in one video: a short
   attribution, a long mid-roll read, and a short outro callback. Report each
   occurrence as its own segment; never merge them into one span.

Never merge separate ads across editorial content - if promotional passages are
separated by non-promotional content, they are separate segments.`;

/** Validated window. See the file comment before changing it. */
const CHUNK_SECONDS = 10;
const MAX_TOKENS = 16000;
const MIN_LEN_S = 1.0;

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Words -> `[MM:SS] text` lines, chunked to CHUNK_SECONDS. */
export function renderTranscript(words: Word[]): string {
  const lines: string[] = [];
  let bucket: string[] = [];
  let start: number | null = null;

  for (const [text, ms] of words) {
    const seconds = ms / 1000;
    if (start === null) start = seconds;
    bucket.push(text);
    if (seconds - start >= CHUNK_SECONDS) {
      lines.push(stamp(start, bucket));
      bucket = [];
      start = null;
    }
  }
  if (bucket.length > 0 && start !== null) lines.push(stamp(start, bucket));
  return lines.join("\n");
}

function stamp(start: number, bucket: string[]): string {
  const total = Math.floor(start);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `[${mm}:${ss}] ${bucket.join(" ")}`;
}

/**
 * Recover the JSON object from a reply.
 *
 * Scans for a brace-balanced object containing `segments`, ignoring string
 * contents and escapes, because models emit fences, commentary and `<think>`
 * blocks around the payload.
 */
export function extractSegments(text: string): unknown[] | null {
  if (!text) return null;
  let body = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  body = body.replace(/^\s*```(?:json)?/gm, "").replace(/```\s*$/gm, "").trim();

  for (let i = body.indexOf("{"); i !== -1; i = body.indexOf("{", i + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < body.length; j++) {
      const c = body[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth !== 0) continue;
        try {
          const parsed: unknown = JSON.parse(body.slice(i, j + 1));
          if (parsed && typeof parsed === "object" && "segments" in parsed) {
            const { segments } = parsed;
            if (Array.isArray(segments)) return segments;
          }
        } catch {
          // Not the object we want; keep scanning from the next brace.
        }
        break;
      }
    }
  }
  return null;
}

/** Clamp and sanity-filter what the model returned. */
function toSegments(raw: unknown[], duration: number): Segment[] {
  const out: Segment[] = [];
  for (const item of raw) {
    // Untrusted: this came from whichever endpoint the user configured.
    if (!item || typeof item !== "object") continue;
    const start = "start" in item ? Number(item.start) : Number.NaN;
    const end = "end" in item ? Number(item.end) : Number.NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    const a = Math.max(0, Math.min(start, end));
    const b = duration > 0 ? Math.min(Math.max(start, end), duration) : Math.max(start, end);
    if (b - a < MIN_LEN_S) continue;

    // The prompt only ever asks for external advertisers, so anything returned
    // is a sponsor; self-promo is explicitly excluded from its definition.
    const category: Category = "sponsor";
    // No score: see Segment.score. The model gives no probability.
    out.push({ category, start: a, end: b });
  }
  return out.sort((x, y) => x.start - y.start);
}

export interface LlmResult {
  segments?: Segment[];
  error?: string;
}

export async function detectWithLlm(
  words: Word[],
  duration: number,
  config: LlmConfig,
): Promise<LlmResult> {
  const doc = renderTranscript(words);
  const user =
    `Video duration: ${Math.round(duration)} seconds.\n` +
    `Transcript lines are prefixed with their start time as [MM:SS].\n\n` +
    `${doc}\n\n` +
    `Identify every sponsor segment. Output the JSON object only.`;

  // Accept a base URL with or without the /chat/completions suffix, since users
  // paste both forms.
  const base = config.baseUrl.replace(/\/+$/, "");
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;

  let reply: string;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: user },
        ],
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      return { error: `HTTP ${response.status}: ${detail}` };
    }
    const data: unknown = await response.json();
    reply = readContent(data);
  } catch (err) {
    return { error: `request failed: ${String(err).slice(0, 200)}` };
  }

  const raw = extractSegments(reply);
  if (!raw) return { error: "could not parse a JSON object from the reply" };
  return { segments: toSegments(raw, duration) };
}

/**
 * Pull the assistant message out of an OpenAI-compatible response.
 *
 * Narrowed step by step rather than asserted: the endpoint is whatever URL the
 * user configured, so the shape is genuinely unknown and a wrong guess here
 * would read `undefined` and look like an empty reply.
 */
function readContent(data: unknown): string {
  if (!data || typeof data !== "object" || !("choices" in data)) return "";
  const { choices } = data;
  if (!Array.isArray(choices) || choices.length === 0) return "";

  const first: unknown = choices[0];
  if (!first || typeof first !== "object" || !("message" in first)) return "";
  const { message } = first;
  if (!message || typeof message !== "object" || !("content" in message)) return "";

  const { content } = message;
  return typeof content === "string" ? content : "";
}
