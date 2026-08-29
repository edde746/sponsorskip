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

export type Backend = "webgpu" | "wasm";

export interface DetectorInit {
  /** Directory holding the model variants, metas and tokenizer/. */
  baseUrl: string;
}

/**
 * Which model each backend gets, and why they are different models.
 *
 * WebGPU gets the 44M-parameter 6-layer truncated ModernBERT at fp16: test
 * F1 0.784, and fp16 is nearly free on a GPU. WASM gets the 19.3M distilled
 * student at int8: test F1 0.714, but 79 ms per window on CPU against roughly
 * 2.5 s for the bigger graph, which is the difference between usable and not.
 *
 * int8 is also not interchangeable across the two. Quantising the big model to
 * int8 measured a 0.082 F1 loss, while it is nearly free for the small
 * distilled one -- so each backend ships the format its model tolerates.
 */
const VARIANTS: Record<Backend, { model: string; meta: string }> = {
  webgpu: { model: "detector_fp16.onnx", meta: "detector_meta.json" },
  wasm: { model: "fallback_int8.onnx", meta: "fallback_meta.json" },
};

export class Detector {
  private session!: ort.InferenceSession;
  private tokenizer!: Tokenizer;
  private meta!: DetectorMeta;
  /** original vocab id -> pruned row index. Dense for O(1) remap. */
  private vocabMap!: Int32Array;
  backend!: Backend;
  modelVersion = "unknown";

  async init({ baseUrl }: DetectorInit): Promise<void> {
    // ORT fetches its WASM binaries at runtime; point it at our copies rather
    // than the default CDN path, which an extension CSP would refuse anyway.
    ort.env.wasm.wasmPaths = chrome.runtime.getURL("ort/");

    const [tokenizerJson, tokenizerConfig] = await Promise.all([
      fetch(`${baseUrl}/tokenizer/tokenizer.json`).then((r) => r.json()),
      fetch(`${baseUrl}/tokenizer/tokenizer_config.json`).then((r) => r.json()),
    ]);
    this.tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);

    const preferred: Backend =
      typeof navigator !== "undefined" && "gpu" in navigator ? "webgpu" : "wasm";
    try {
      await this.loadVariant(baseUrl, preferred);
    } catch (err) {
      // A driver can advertise WebGPU and still refuse the graph. Retrying on
      // WASM with the small model beats failing the whole feature.
      if (preferred === "wasm") throw err;
      console.warn("[sponsorskip] webgpu unavailable, falling back to wasm", err);
      await this.loadVariant(baseUrl, "wasm");
    }
  }

  private async loadVariant(baseUrl: string, backend: Backend): Promise<void> {
    const variant = VARIANTS[backend];
    this.meta = await fetch(`${baseUrl}/${variant.meta}`).then((r) => r.json());

    // `keep[i] = originalId` -> invert into originalId -> i. The two variants
    // have different pruned vocabularies, so this must follow the meta load.
    this.vocabMap = new Int32Array(50368);
    for (let i = 0; i < this.meta.keep.length; i++) {
      this.vocabMap[this.meta.keep[i]] = i;
    }

    this.session = await ort.InferenceSession.create(`${baseUrl}/${variant.model}`, {
      executionProviders: [backend],
      graphOptimizationLevel: "all",
    });
    this.backend = backend;
    this.modelVersion = variant.model.replace(/\.onnx$/, "");
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
   * Turn per-word probabilities into merged segments.
   *
   * Mirrors `decode`: threshold the summed ad probability, name each run by the
   * majority ad class inside it, then merge same-brand runs separated by less
   * than `MERGE_GAP_S` and drop anything shorter than `MIN_LEN_S`.
   */
  private decode(probs: Float32Array, words: Word[], threshold: number): Segment[] {
    const nLabels = this.meta.labels.length;
    const runs: Array<[number, number]> = [];
    let cur: [number, number] | null = null;

    const pAd = new Float32Array(words.length);
    const argmax = new Int32Array(words.length);
    for (let w = 0; w < words.length; w++) {
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

    for (let w = 0; w < words.length; w++) {
      if (pAd[w] >= threshold) cur = cur === null ? [w, w] : [cur[0], w];
      else if (cur !== null) {
        runs.push(cur);
        cur = null;
      }
    }
    if (cur !== null) runs.push(cur);

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

  /** Full pass: words in, segments out. */
  async detect(words: Word[], threshold = this.meta.threshold): Promise<Segment[]> {
    if (words.length === 0) return [];
    const probs = await this.wordProbs(words);
    return this.decode(probs, words, threshold);
  }
}
