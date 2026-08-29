/**
 * Sponsor detector: ONNX token classifier over transcript words.
 *
 * This is a line-for-line port of the validated Python inference path
 * (`run_student.py::word_probs` / `::decode`). The numbers it has to reproduce
 * were measured with that code, so the port is deliberately literal:
 * fixed 2048-token windows, 0.5 stride, first-subtoken pooling per word,
 * probability averaging across overlapping windows, then span decoding.
 *
 * Two conventions here are load-bearing and were established empirically
 * against HuggingFace, not guessed:
 *
 *  1. ModernBERT's tokenizer has `add_prefix_space=False`, so HF's
 *     `is_split_into_words=True` is exactly "encode each word independently
 *     with no leading space and concatenate". Verified token-for-token:
 *     ["hey","guys",...] -> [26512, 4297, 656, 88, ...] under both paths.
 *     Prepending spaces produces completely different ids (18981, 6068, ...)
 *     and would silently wreck accuracy, so do not "tidy" this.
 *
 *  2. The graph is traced at a fixed [1, 2048] shape, so every window is
 *     padded to 2048 and masked. Do not switch to dynamic axes without
 *     re-exporting.
 */
import * as ort from "onnxruntime-web/webgpu";
import { Tokenizer } from "@huggingface/tokenizers";

import { loadManifest, resolveVariant, type ProgressFn } from "./modelStore";

import type { Category, DetectorMeta, Segment, Word } from "../shared/types";

/** Label ids that mean "this is an ad". Id 0 is O. */
const AD_IDS = [1, 2, 3, 4] as const;
/** Label id -> brand, for naming a decoded span. */
const CAT_OF: Record<number, Category> = {
  1: "sponsor",
  2: "sponsor",
  3: "selfpromo",
  4: "selfpromo",
};

/** Decode tuning, carried over verbatim from the Python reference. */
const MIN_LEN_S = 1.0;
const MERGE_GAP_S = 2.0;
/** Captions stamp a word's start; add the tail so a span covers its last word. */
const WORD_TAIL_S = 0.4;

export type Backend = "webgpu";

export interface DetectorInit {
  /** Which entry of variants.json to load. */
  variant: string;
  /** Forwarded to the popup so a 724 MB download is visible, not a hang. */
  onProgress?: ProgressFn;
}

/** Thrown when the device cannot run the model. Surfaces as `no_webgpu`. */
export class NoWebGPUError extends Error {
  constructor(cause?: unknown) {
    super("WebGPU is unavailable");
    this.name = "NoWebGPUError";
    this.cause = cause;
  }
}

export class Detector {
  private session!: ort.InferenceSession;
  private tokenizer!: Tokenizer;
  private meta!: DetectorMeta;
  /** original vocab id -> pruned row index. Dense for O(1) remap. */
  private vocabMap!: Int32Array;
  backend: Backend = "webgpu";
  modelVersion = "unknown";

  /**
   * There is deliberately no CPU fallback.
   *
   * A 19.3M distilled student was shipped as one, and measuring it against
   * SponsorBlock crowd labels showed a mean absolute start error of ~11 s. A
   * skip eleven seconds off target is worse than no skip: it cuts content and
   * still plays the ad. Hysteresis raised its F1 from 0.603 to 0.657 but left
   * the error at ~11 s, so it was removed rather than shipped quietly.
   *
   * Running the accurate model on WASM is the honest way to support these
   * devices, but at roughly 2.5 s per window it needs its own measured int8
   * export before it can be offered.
   */
  async init({ variant, onProgress }: DetectorInit): Promise<void> {
    if (typeof navigator === "undefined" || !("gpu" in navigator)) {
      throw new NoWebGPUError();
    }

    // ORT fetches its WASM binaries at runtime; point it at our copies rather
    // than the default CDN path, which an extension CSP would refuse anyway.
    ort.env.wasm.wasmPaths = chrome.runtime.getURL("ort/");

    // The tokenizer is always the bundled one: every variant is ModernBERT and
    // shares it, so there is nothing to download and nothing to keep in sync.
    const base = chrome.runtime.getURL("models");
    const [tokenizerJson, tokenizerConfig] = await Promise.all([
      fetch(`${base}/tokenizer/tokenizer.json`).then((r) => r.json()),
      fetch(`${base}/tokenizer/tokenizer_config.json`).then((r) => r.json()),
    ]);
    this.tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);

    const manifest = await loadManifest();
    const resolved = await resolveVariant(manifest, variant,
                                          onProgress ?? (() => undefined));
    this.meta = resolved.meta as DetectorMeta;

    this.vocabMap = new Int32Array(50368);
    for (let i = 0; i < this.meta.keep.length; i++) {
      this.vocabMap[this.meta.keep[i]] = i;
    }

    try {
      // From bytes, not a URL: the remote variant lives in the Cache API and
      // never becomes a fetchable extension path.
      this.session = await ort.InferenceSession.create(
        new Uint8Array(resolved.model), {
          executionProviders: ["webgpu"],
          graphOptimizationLevel: "all",
        });
    } catch (err) {
      // A driver can advertise WebGPU and still refuse the graph.
      throw new NoWebGPUError(err);
    }
    this.modelVersion = resolved.version;
  }

  /**
   * Tokenize pre-split words, tracking which word each subtoken came from.
   *
   * Equivalent to HF `tokenizer(words, is_split_into_words=True,
   * add_special_tokens=False)` for this tokenizer. See the class comment for
   * why no prefix space is added.
   */
  private encodeWords(words: Word[]): { ids: number[]; wordIds: number[] } {
    const ids: number[] = [];
    const wordIds: number[] = [];
    for (let w = 0; w < words.length; w++) {
      const piece = this.tokenizer.encode(words[w][0], { add_special_tokens: false }).ids;
      for (const id of piece) {
        ids.push(id);
        wordIds.push(w);
      }
    }
    return { ids, wordIds };
  }

  /**
   * Per-word class probabilities, averaged over every window covering the word.
   *
   * Mirrors `word_probs`: windows of `max_len - 2` body tokens advancing by
   * `stride_frac`, CLS/SEP wrapped, padded to the traced length, and only the
   * first subtoken of each word contributes.
   */
  private async wordProbs(words: Word[]): Promise<Float32Array> {
    const nLabels = this.meta.labels.length;
    const { ids, wordIds } = this.encodeWords(words);
    const maxLen = this.meta.max_len;
    const body = maxLen - 2;
    const step = Math.max(1, Math.floor(body * this.meta.stride_frac));

    const acc = new Float32Array(words.length * nLabels);
    const cnt = new Float32Array(words.length);

    const input = new BigInt64Array(maxLen);
    const mask = new BigInt64Array(maxLen);
    const padPruned = BigInt(this.vocabMap[this.meta.pad_token_id]);

    for (let s = 0; ; s += step) {
      const e = Math.min(ids.length, s + body);

      // Remap to pruned ids on the way in; the graph's embedding is pruned.
      input.fill(padPruned);
      mask.fill(0n);
      input[0] = BigInt(this.vocabMap[this.meta.cls_token_id]);
      mask[0] = 1n;
      let k = 1;
      for (let i = s; i < e; i++, k++) {
        input[k] = BigInt(this.vocabMap[ids[i]]);
        mask[k] = 1n;
      }
      input[k] = BigInt(this.vocabMap[this.meta.sep_token_id]);
      mask[k] = 1n;

      const out = await this.session.run({
        input_ids: new ort.Tensor("int64", input, [1, maxLen]),
        attention_mask: new ort.Tensor("int64", mask, [1, maxLen]),
      });
      const logits = out.logits.data as Float32Array;

      // Softmax + first-subtoken pooling. `prev` resets per window, matching
      // the reference: a window starting mid-word lets that word's first
      // visible subtoken stand in for it.
      let prev = -1;
      for (let i = s; i < e; i++) {
        const w = wordIds[i];
        if (w === prev) continue;
        prev = w;

        const off = (i - s + 1) * nLabels; // +1 skips CLS
        let max = -Infinity;
        for (let c = 0; c < nLabels; c++) max = Math.max(max, logits[off + c]);
        let sum = 0;
        for (let c = 0; c < nLabels; c++) sum += Math.exp(logits[off + c] - max);
        for (let c = 0; c < nLabels; c++) {
          acc[w * nLabels + c] += Math.exp(logits[off + c] - max) / sum;
        }
        cnt[w] += 1;
      }

      if (e >= ids.length) break;
    }

    for (let w = 0; w < words.length; w++) {
      const d = Math.max(cnt[w], 1);
      for (let c = 0; c < nLabels; c++) acc[w * nLabels + c] /= d;
    }
    return acc;
  }

  /**
   * Turn per-word probabilities into merged segments, using hysteresis.
   *
   * A confident "core" above `thHi` establishes that a segment exists; its
   * edges are then walked outward while probability stays above `thLo`. This is
   * the fix for skips firing late. With a single threshold the two jobs fight:
   * raising it improves F1 and pushes starts later, because the run cannot begin
   * until the model is already certain — several words into the sponsor read.
   *
   * Measured on SponsorBlock crowd labels, held-out half, full-depth base:
   *   single 0.60      F1 0.771, start +0.86 s
   *   hysteresis .7/.3 F1 0.802, start -0.32 s
   * Better on both axes at once, so there is no tradeoff being made here.
   */
  private decode(probs: Float32Array, words: Word[], thHi: number, thLo: number): Segment[] {
    const nLabels = this.meta.labels.length;
    const n = words.length;

    const pAd = new Float32Array(n);
    const argmax = new Int32Array(n);
    for (let w = 0; w < n; w++) {
      let p = 0;
      for (const c of AD_IDS) p += probs[w * nLabels + c];
      pAd[w] = p;

      let best = 0;
      let bestV = -Infinity;
      for (let c = 0; c < nLabels; c++) {
        const v = probs[w * nLabels + c];
        if (v > bestV) {
          bestV = v;
          best = c;
        }
      }
      argmax[w] = best;
    }

    const runs: Array<[number, number]> = [];
    for (let i = 0; i < n; ) {
      if (pAd[i] < thHi) {
        i++;
        continue;
      }
      // Extend the core while still confident.
      let j = i;
      while (j + 1 < n && pAd[j + 1] >= thHi) j++;
      // Then relax outward to find the true edges.
      let a = i;
      while (a - 1 >= 0 && pAd[a - 1] >= thLo) a--;
      let b = j;
      while (b + 1 < n && pAd[b + 1] >= thLo) b++;
      runs.push([a, b]);
      // Resume past the expanded end, so one core cannot be claimed twice.
      i = b + 1;
    }

    const segs: Segment[] = runs.map(([a, b]) => {
      const tally = new Map<number, number>();
      for (let w = a; w <= b; w++) {
        const c = argmax[w];
        if (c in CAT_OF) tally.set(c, (tally.get(c) ?? 0) + 1);
      }
      let brand: Category = "sponsor";
      let bestN = 0;
      for (const [c, n] of tally) {
        if (n > bestN) {
          bestN = n;
          brand = CAT_OF[c];
        }
      }
      let score = 0;
      for (let w = a; w <= b; w++) score += pAd[w];
      return {
        category: brand,
        start: words[a][1] / 1000,
        end: words[b][1] / 1000 + WORD_TAIL_S,
        score: score / (b - a + 1),
      };
    });

    const merged: Segment[] = [];
    for (const s of segs.sort((x, y) => x.start - y.start)) {
      const last = merged[merged.length - 1];
      if (last && s.start - last.end <= MERGE_GAP_S && s.category === last.category) {
        // Weight the merged score by span length so a long confident run is not
        // dragged down by a short adjacent one.
        const lw = last.end - last.start;
        const sw = s.end - s.start;
        last.score = (last.score * lw + s.score * sw) / Math.max(lw + sw, 1e-6);
        last.end = Math.max(last.end, s.end);
      } else {
        merged.push({ ...s });
      }
    }
    return merged.filter((s) => s.end - s.start >= MIN_LEN_S);
  }

  /**
   * Full pass: words in, segments out.
   *
   * Falls back to a single threshold for artifacts exported before the
   * hysteresis pair existed, so an older model file still behaves as it did.
   */
  async detect(words: Word[], thresholdLo?: number): Promise<Segment[]> {
    if (words.length === 0) return [];
    const thHi = this.meta.threshold_hi ?? this.meta.threshold;
    // Clamped below thHi: a low threshold above the high one would make the
    // expansion step a no-op and silently disable hysteresis.
    const thLo = Math.min(thresholdLo ?? this.meta.threshold_lo ?? this.meta.threshold, thHi);
    const probs = await this.wordProbs(words);
    return this.decode(probs, words, thHi, thLo);
  }
}
