/**
 * Guards the single most dangerous assumption in this extension: that
 * tokenizing in JavaScript produces byte-identical input ids to the Python
 * pipeline the model was trained with.
 *
 * A silent divergence here would not crash anything. It would just quietly
 * degrade accuracy, and every downstream number we have measured would become a
 * lie. So this is checked explicitly rather than assumed.
 *
 * What it proves: per-word `encode(word, {add_special_tokens: false})`
 * concatenated in order == HF `tokenizer(words, is_split_into_words=True,
 * add_special_tokens=False)`, including the word-id alignment used for
 * first-subtoken pooling. ModernBERT's tokenizer has `add_prefix_space=False`,
 * which is why no leading space is added; prepending one changes every id.
 *
 * Regenerate the reference (needs the repo's Python env):
 *
 *   ./.venv-sbml/bin/python - <<'PY'
 *   import json
 *   from transformers import AutoTokenizer
 *   d = json.load(open("eval/test_words.json"))
 *   t = AutoTokenizer.from_pretrained("answerdotai/ModernBERT-base")
 *   out = {}
 *   for v in list(d.keys())[:8]:
 *       words = d[v]["words"][:5000]
 *       enc = t(words, is_split_into_words=True, add_special_tokens=False, truncation=False)
 *       out[v] = {"words": words, "ids": enc["input_ids"], "word_ids": enc.word_ids()}
 *   json.dump(out, open("/tmp/tok_ref.json", "w"))
 *   PY
 *
 * Then: node tools/tokenizer-parity.mjs [refPath] [tokenizerDir]
 */
import { Tokenizer } from "@huggingface/tokenizers";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const refPath = process.argv[2] ?? "/tmp/tok_ref.json";
const tokenizerDir =
  process.argv[3] ??
  join(
    process.env.HOME ?? "",
    ".cache/huggingface/hub/models--answerdotai--ModernBERT-base/snapshots",
    "8949b909ec900327062f0ebf497f51aef5e6f0c8",
  );

// The reference is generated from the research corpus, which is not published
// with this repository. Skip clearly rather than fail: a red check that nobody
// outside the project can ever make green is worse than an explicit skip.
if (!existsSync(refPath)) {
  console.log(`SKIP: no tokenizer reference at ${refPath}`);
  console.log("Generate one with the snippet in this file's header, or pass a path.");
  process.exit(0);
}

// Prefer the tokenizer we actually ship; fall back to a local HF cache.
const shippedTokenizer = join(dirname(dirname(fileURLToPath(import.meta.url))), "models", "tokenizer");
const tokenizerRoot = existsSync(join(shippedTokenizer, "tokenizer.json"))
  ? shippedTokenizer
  : tokenizerDir;

const tokenizer = new Tokenizer(
  JSON.parse(readFileSync(join(tokenizerRoot, "tokenizer.json"), "utf8")),
  JSON.parse(readFileSync(join(tokenizerRoot, "tokenizer_config.json"), "utf8")),
);
const reference = JSON.parse(readFileSync(refPath, "utf8"));

let words = 0;
let tokens = 0;
let idMismatch = 0;
let wordIdMismatch = 0;
let firstBad = null;

for (const [videoId, entry] of Object.entries(reference)) {
  const ids = [];
  const wordIds = [];
  for (let w = 0; w < entry.words.length; w++) {
    for (const id of tokenizer.encode(entry.words[w], { add_special_tokens: false }).ids) {
      ids.push(id);
      wordIds.push(w);
    }
  }

  words += entry.words.length;
  tokens += Math.max(ids.length, entry.ids.length);

  if (ids.length !== entry.ids.length) {
    idMismatch += Math.abs(ids.length - entry.ids.length);
    firstBad ??= { videoId, why: "length", js: ids.length, py: entry.ids.length };
  }
  for (let i = 0; i < Math.min(ids.length, entry.ids.length); i++) {
    if (ids[i] !== entry.ids[i]) {
      idMismatch++;
      firstBad ??= { videoId, i, js: ids[i], py: entry.ids[i], word: entry.words[wordIds[i]] };
    }
    if (wordIds[i] !== entry.word_ids[i]) wordIdMismatch++;
  }
}

console.log(`videos          ${Object.keys(reference).length}`);
console.log(`words           ${words}`);
console.log(`tokens          ${tokens}`);
console.log(`id mismatches   ${idMismatch}`);
console.log(`word-id mismatch ${wordIdMismatch}`);
console.log(`parity          ${(100 * (1 - idMismatch / tokens)).toFixed(4)}%`);

if (idMismatch > 0 || wordIdMismatch > 0) {
  console.error("FAIL: tokenization diverges from training.", firstBad);
  process.exit(1);
}
console.log("PASS: JS tokenization is identical to the training pipeline.");
