# SponsorSkip

[![CI](https://github.com/edde746/sponsorskip/actions/workflows/ci.yml/badge.svg)](https://github.com/edde746/sponsorskip/actions/workflows/ci.yml)

Skips YouTube sponsor segments using a local transcript model. No crowd-sourced
timestamps, no server, no telemetry. The transcript is fetched by your own
browser and the model runs on your own GPU.

It is not a SponsorBlock client. There is no database to query and nothing to
submit — segments are predicted from the video's own captions, on your machine,
which means it works on videos nobody has ever labelled.

## Install

```
npm install
npm run fetch-models   # ~146 MB from HuggingFace, checksum-verified
npm run build          # -> dist/
```

Load `dist/` via `chrome://extensions` → Developer mode → Load unpacked.
Requires Chrome 116+ (offscreen documents + WebGPU).

Other scripts: `npm run typecheck`, `npm run check-tokenizer`, `npm run watch`.

## Weights

Hosted on HuggingFace, **not** in this repository:
**[edde746/sponsorskip-modernbert](https://huggingface.co/edde746/sponsorskip-modernbert)**

Two reasons, one hard and one deliberate. The hard one: `detector_fp16.onnx` is
116.4 MiB and GitHub refuses any file over 100 MiB. The deliberate one: the code
and the weights are under different licences, and separate artifacts keep that
split unambiguous. `models.json` pins the exact files with SHA-256 checksums;
`npm run fetch-models` refuses anything that does not match, because a truncated
model would not crash — it would quietly predict worse segments.

## Licence

**Code: GPL-3.0-or-later.** `src/content/dom.ts` adapts the progress-bar
selector table from [SponsorBlock](https://github.com/ajayyy/SponsorBlock)
(`src/content.ts::getPreviewBarAttachElement`), which is GPL-3.0. That makes this
a derivative work and the copyleft is inherited deliberately.

**Weights: CC BY-NC-SA 4.0 — non-commercial**, inherited from the SponsorBlock
database they were trained on. If you plan to charge for anything built on this,
the weights are the blocker, not the code.

## Architecture

Four contexts, because the platform forces it — each capability exists in
exactly one place:

| context | file | why it must be there |
|---|---|---|
| main world | `src/page/` | only origin InnerTube accepts |
| isolated world | `src/content/` | only context with both DOM and extension APIs |
| service worker | `src/background/` | only context that outlives a page |
| offscreen document | `src/offscreen/` | only context with WebGPU that survives |

Flow: content script sees a video id → asks the worker (cache hit ends it here)
→ on a miss asks the main world to fetch the transcript → hands words to the
worker → worker runs the offscreen model → segments come back, get cached, get
drawn and scheduled.

### The origin problem

The single most important constraint, measured on one video in one browser:

| context | result |
|---|---|
| page main world (`https://www.youtube.com`) | **HTTP 200**, 4065 words |
| content script isolated world | HTTP 403 |
| service worker | HTTP 403 |

MV3 routes content-script fetches through the extension's network context, so
both the isolated world and the worker send `Origin: chrome-extension://…` and
InnerTube refuses them. Only a `world: "MAIN"` script fetches as the page. This
is why SponsorBlock also ships a MAIN-world script, and why `src/page/` exists
and contains nothing but the fetch.

### Models

Each backend gets the model whose format it can afford. See
`src/offscreen/detector.ts`.

| backend | model | size | test F1 | speed |
|---|---|---|---|---|
| WebGPU | 6-layer truncated ModernBERT, pruned vocab, fp16 | 122 MB | **0.788** | 845 ms / 19-min video |
| WASM | 19.3M distilled student, int8 | 20 MB | 0.714 | 79 ms / window |

int8 is not interchangeable: quantising the big model to int8 costs 0.082 F1,
while it is nearly free for the small distilled one. Vocabulary pruning dropped
the embedding table from 50,368 to 17,536 rows (62% of the model's parameters)
and is bit-identical — max abs logit delta 0, argmax parity 100%.

`detector_fp32.onnx` is not shipped. It exists as the parity reference for the
fp16 export, and a 6-layer model on CPU is ~30x slower than the student it would
be replacing.

## Things that must not be "tidied"

Each of these was a real bug, found the hard way.

- **Tokenization adds no prefix space.** ModernBERT's tokenizer has
  `add_prefix_space=False`, so HF's `is_split_into_words=True` is exactly
  "encode each word alone and concatenate". Prepending spaces yields completely
  different ids and would silently wreck accuracy. Guarded by
  `tools/tokenizer-parity.mjs`: 22,951 words / 29,737 tokens, **0 mismatches**.
- **`attention_mask` must be zeroed over padding.** The graph is traced at a
  fixed `[1, 2048]`. Verified live in the graph: changing pad content with
  `mask=0` moves logits by 0.0, while an all-ones mask moves them by 4.37.
- **Remap special tokens too.** `cls`/`sep`/`pad` in `detector_meta.json` are
  original vocab ids. Build the window in original id space, then apply the
  pruned-vocab map to the whole array including the pad filler.
- **Observe `document.documentElement`, not `document.body`.** Content scripts
  run at `document_start`, where `body` is null. Observing it throws inside an
  async chain, so the watcher silently never starts — and whether it happens is
  a parse-timing race.
- **Detection must not depend on the `<video>` element.** It needs only the
  video id. Gating on the element means a slow or broken player suppresses
  detection entirely.
- **Never cache a row with an unknown model version.** The sentinel collides
  with itself: a row stored before the model loaded, and a lookup before the
  model loaded, both carry `"unknown"`, so the check that exists to invalidate
  stale rows instead validates them. This served a poisoned negative forever.
- **Suspend everything during ad breaks.** `#movie_player.ad-showing` means the
  reused `<video>` reports the *ad's* `duration` and `currentTime`, so segment
  timestamps refer to a different timeline.
- **Content scripts are classic scripts.** They must be IIFEs; only extension
  pages and the worker are modules. `build.mjs` splits the formats explicitly.

## Skip scheduling

`src/content/skipper.ts` re-derives SponsorBlock's approach rather than copying
it: never poll `currentTime`, compute the next boundary once, arm a single
timer, and cancel-and-re-arm on every invalidating event. Frame accuracy comes
from three details — a `performance.now()` virtual clock (browsers quantise
`currentTime`), escalation to a zero-delay interval for the last 250 ms, and
re-validating the video id inside every callback so a timer armed before an SPA
navigation cannot seek the wrong video.

## Verification status

Verified in Chrome 146 with the extension loaded, against hand-labelled ground
truth:

| video | detected | ground truth | confidence |
|---|---|---|---|
| `WSLW1A6Q5a4` | 35.0 – 99.7 s | 36.0 – 96.7 s | 0.97 |
| `I9zqGeH8EIs` | 186.6 – 227.7 s | 190.0 – 222.6 s | 0.91 |

Both within the model's 4.43 s mean boundary error. The second row was read back
out of the rendered progress-bar geometry, so it also confirms the bar draws
against the real timeline. `backend: "webgpu"` confirmed — the fp16 graph loads
and runs. SPA navigation, caching, and ad suppression all confirmed.

**Not verified:** the seek itself and the skip notice. Chrome for Testing cannot
decode YouTube's media (no proprietary codecs), so playback never advances and
pre-roll ads never end. The skip path needs a manual check in a normal Chrome.

## CI and releases

`npm run verify` (`tools/verify-dist.mjs`) is the gate that runs on every push.
It is browser-free and deterministic, and it asserts the failure modes listed
under "Things that must not be tidied" — all of which install cleanly and only
break at runtime. Every check has been negative-tested, which is how a bug in
the ESM detector itself was caught: the original regex missed
`import x from "y"`.

Model artifacts are cached on the hash of `models.json`. Since that file pins
each artifact by SHA-256, the cache key is effectively content-addressed —
change a weight and the key changes with it.

To cut a release:

```
# bump the version in BOTH manifest.json and package.json, commit, then:
git tag v0.2.0 && git push origin v0.2.0
```

The workflow refuses to publish if the tag disagrees with `manifest.json`.
That check exists because Chrome silently rejects an update whose version is
not newer, which is painful to diagnose after the fact. It produces two assets:

| asset | contents |
|---|---|
| `sponsorskip-<v>-chrome.zip` | ~113 MB, unzip and Load unpacked, model included |
| `sponsorskip-<v>-source.zip` | ~76 KB, code only, run `npm run fetch-models` |

Chrome Web Store publishing is **not** automated — it needs `CLIENT_ID`,
`CLIENT_SECRET` and `REFRESH_TOKEN` secrets, and half-configured store
automation fails in confusing ways. Upload the `chrome` zip manually.
