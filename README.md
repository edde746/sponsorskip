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

WebGPU only. Two selectable detectors; see `variants.json` and
`src/offscreen/modelStore.ts`.

| | Base | Large |
|---|---|---|
| params | 124.4M | 362.2M |
| download | bundled (270 MB) | 724 MB, once |
| F1 | 0.808 | **0.834** |
| mean absolute start error | 2.98 s | **2.33 s** |
| overshoot at segment end | +1.28 s | **+0.46 s** |
| boundary error | 2.62 s | **2.49 s** |

Base is bundled so the extension works offline the moment it installs. Large is
fetched on demand from HuggingFace, verified against a SHA-256 recorded at build
time, and kept in the Cache API — so it downloads once, with progress shown in
the popup. A truncated or substituted graph would not crash, it would quietly
predict worse segments, which is why the checksum is enforced rather than
assumed.

Large is better on every measured axis, and most visibly at segment ends: on one
test video it stops at 224.3 s against a true end of 222.6 s, where base runs to
231.7 s. That is 1.7 s of content lost instead of 9.1 s.

Measured against **SponsorBlock crowd labels** (tier A, channel-disjoint
validation split, held-out half), not the hand-labelled set. That distinction
matters: hand labels start segments +1.25 s later than crowd labels on average,
and tuning a threshold against them is what made an earlier build skip late.

There is no CPU fallback. A 19.3M distilled student shipped as one, and measuring
it properly showed ~11 s mean absolute start error -- it only stopped being late
by being symmetrically wrong. A skip eleven seconds off target cuts content and
still plays the ad, so it was removed rather than shipped quietly. Devices
without WebGPU get an explicit `no_webgpu` explanation.

`detector_fp32.onnx` is not shipped; it is the parity reference for the fp16
export.

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

## LLM mode

An alternative engine: instead of running a model locally, send the transcript to
any OpenAI-compatible endpoint you configure with your own URL, key and model.
Off by default.

The prompt, the 10-second transcript chunking and the JSON recovery are ports of
the benchmarked research pipeline, selected over 749 calls. Three details earn
their keep and should not be simplified:

- **10-second lines.** The window is a hard floor on boundary precision, because
  the model can only cite a line's start time. At 20 s, boundaries quantise by
  ~10.6 s on average; at 10 s, ~4.6 s.
- **An explicit short-segment sweep.** Without it, models almost entirely miss
  1-5 s pre-roll tags and one-sentence outro callbacks.
- **Balanced-brace JSON recovery.** Replies arrive wrapped in fences, prose and
  `<think>` blocks; parsing the whole reply fails constantly.

It is an alternative, not an upgrade. On the 93-video hand-labelled set:

| | F1 | precision | recall |
|---|---|---|---|
| local (large) | 0.834 | 0.817 | 0.851 |
| LLM (`glm-5.3-flash`) | 0.821 | **0.923** | **0.740** |

The two fail in opposite directions. The LLM flags less but is right more often
when it does; the local model finds more and over-flags. Observed directly on one
test video: the LLM returned 183.5-212.0 s against a true 190.0-222.6 s, ending
**10 s early** and so leaving ad audio playing. Pick on which error you prefer.

Practical notes: about $0.00085 per video and a few seconds of latency, versus
~800 ms locally. The API key is kept in `chrome.storage.local`, never
`storage.sync`, so it is not replicated to every device signed into the browser.
The endpoint host cannot be a static permission, so it is requested at runtime
for exactly the origin you enter, on **Test connection**. LLM segments carry no
confidence value — the model does not emit one, and the UI shows no percentage
rather than inventing 100%.

## Decode: hysteresis, not a single threshold

The single most impactful accuracy fix in this project was not the model, it was
the decoder. A high threshold decides *whether* a segment exists; a low one
decides *where its edges are*, by expanding outward from the confident core.

With one threshold the two jobs fight. Raising it improves F1 and pushes starts
later, because a run cannot begin until the model is already certain -- several
words into the sponsor read. Measured on crowd labels, held-out half:

| decode | F1 | segment start |
|---|---|---|
| single 0.60 | 0.771 | **+0.86 s (late)** |
| hysteresis 0.70 / 0.30 | **0.802** | **-0.32 s** |

Better on both axes at once, so nothing is being traded. Verified faithful: with
equal thresholds it reproduces the old decoder exactly, which is the check that
caught an off-by-one in the expansion loop.

`threshold_lo` is exposed in the popup as **Skip edges**, because the right value
is a matter of taste rather than correctness -- whether you would rather hear a
second of ad or lose a second of content:

| setting | `threshold_lo` | mean start |
|---|---|---|
| conservative | 0.40 | +0.08 s |
| balanced (default) | 0.30 | -0.58 s |
| eager | 0.20 | -1.05 s |

Changing it invalidates cached segments, since the cache key includes the decode
setting; otherwise the change would appear to do nothing until the cache aged out.

Per-video variance is much larger than these averages. On one test video the
model over-extends by ~8 s at both ends regardless of threshold, because its
probability profile is broad rather than sharp.

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
truth (`threshold_lo` 0.30, the default):

| video | detected | ground truth |
|---|---|---|
| `WSLW1A6Q5a4` | 35.0 - 98.3 s | 36.0 - 96.7 s |
| `I9zqGeH8EIs` | 183.9 - 231.7 s | 190.0 - 222.6 s |

The second is the over-extending outlier described above; the first is typical.
`backend: "webgpu"` confirmed -- the fp16 graph loads and runs. SPA navigation,
caching, decode-aware cache invalidation, and ad suppression all confirmed. The
preview bar was read back out of rendered geometry, so it also confirms the bar
draws against the real timeline rather than an ad's.

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
