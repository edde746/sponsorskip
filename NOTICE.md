# Licences in this build

A built SponsorSkip package contains two works under two different licences.
They are separate files and neither is linked into the other: the model is data
loaded at runtime.

## Code — GPL-3.0-or-later

Everything in `*.js`, `*.html`, `*.css` and the manifest.

Copyright (C) 2026 SponsorSkip contributors. Full text in `LICENSE`.

`src/content/dom.ts` adapts the progress-bar attach-point selector table from
**SponsorBlock** by Ajay Ramachandran and contributors
(https://github.com/ajayyy/SponsorBlock), GPL-3.0. This project is therefore a
derivative work and inherits GPL-3.0.

Source for this build: https://github.com/edde746/sponsorskip

## Model weights — CC BY-NC-SA 4.0, non-commercial

Everything under `models/`.

Trained on labels from the **SponsorBlock database**
(https://sponsor.ajay.app/database), licensed CC BY-NC-SA 4.0. The weights
inherit that licence, so:

- **Attribution** — credit the SponsorBlock database as the label source.
- **NonCommercial** — no commercial use.
- **ShareAlike** — derivative models must carry the same licence.

Model card and full evaluation caveats:
https://huggingface.co/edde746/sponsorskip-modernbert

## Bundled third-party code

`onnxruntime-web` (MIT, Microsoft) and `@huggingface/tokenizers` (Apache-2.0,
Hugging Face) are bundled into the JavaScript and the `ort/` WASM binaries.

## Practical summary

The code is free software you may sell. The weights are not licensed for
commercial use. If you intend to charge for anything built on this, the weights
are the blocker — retrain on your own labels.
