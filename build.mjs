/**
 * Build script.
 *
 * esbuild rather than webpack, deliberately: this extension has four flat
 * entry points and a pile of static assets to copy, which is exactly esbuild's
 * sweet spot and none of webpack's. The only non-obvious part is ONNX Runtime,
 * which ships its WASM binaries as separate files that must sit at a URL the
 * extension can fetch, hence the explicit copy into `dist/ort/`.
 */
import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const watch = process.argv.includes("--watch");

/**
 * Content scripts are classic scripts -- `content_scripts` has no
 * `type: "module"` -- so they must be IIFEs. Extension pages and the service
 * worker are loaded as modules. Bundling both groups as ESM happens to work
 * only while no import or export survives bundling, which is a trap, so the
 * formats are separated explicitly.
 */
const CLASSIC_ENTRIES = {
  content: "src/content/index.ts",
  // Main-world script: shares scope with YouTube, holds only the fetch.
  page: "src/page/index.ts",
};

const MODULE_ENTRIES = {
  background: "src/background/index.ts",
  offscreen: "src/offscreen/index.ts",
  popup: "src/popup/popup.ts",
};

/**
 * Model artifacts, populated by `npm run fetch-models` from HuggingFace.
 *
 * Not committed: the fp16 detector is 116.4 MiB and GitHub hard-blocks files
 * over 100 MiB. See models.json.
 */
const MODEL_SRC = join(root, "models");

/**
 * Only what actually ships. `detector_fp32.onnx` is deliberately not even
 * fetched: it exists on HuggingFace as the parity reference for the fp16
 * export, and at 210 MB it would more than double the package for a CPU path
 * that the 19.3M int8 student serves roughly 30x faster anyway.
 */
const MODEL_FILES = [
  "detector_fp16.onnx",
  "detector_meta.json",
  "fallback_int8.onnx",
  "fallback_meta.json",
];
const TOKENIZER_FILES = ["tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"];

async function copyStatic() {
  await mkdir(dist, { recursive: true });

  for (const file of ["manifest.json", "src/content/ui/content.css"]) {
    await cp(join(root, file), join(dist, file.endsWith(".css") ? "content.css" : file));
  }
  for (const file of ["src/popup/popup.html", "src/offscreen/offscreen.html"]) {
    await cp(join(root, file), join(dist, file.split("/").pop()));
  }

  // ORT loads its WASM binary at runtime, so the needed builds must be real
  // files in the package. `onnxruntime-web/webgpu` resolves to the asyncify
  // build; the plain SIMD-threaded build serves the CPU execution provider.
  // Copying the whole dist directory instead would add ~60 MB of jspi, jsep
  // and training builds this extension never loads.
  const ortDist = join(root, "node_modules", "onnxruntime-web", "dist");
  const ortOut = join(dist, "ort");
  await mkdir(ortOut, { recursive: true });
  for (const base of ["ort-wasm-simd-threaded.asyncify", "ort-wasm-simd-threaded"]) {
    for (const ext of [".wasm", ".mjs"]) {
      await cp(join(ortDist, base + ext), join(ortOut, base + ext));
    }
  }

  // Hard failure, not a warning: an extension built without weights installs
  // fine and then reports model_failed on every video, which is a much worse
  // outcome than refusing to build.
  const missing = [
    ...MODEL_FILES.filter((n) => !existsSync(join(MODEL_SRC, n))),
    ...TOKENIZER_FILES.filter((n) => !existsSync(join(MODEL_SRC, "tokenizer", n))),
  ];
  if (missing.length > 0) {
    throw new Error(
      `missing model artifacts in ${MODEL_SRC}:\n` +
        missing.map((n) => `  - ${n}`).join("\n") +
        `\n\nRun: npm run fetch-models`,
    );
  }

  const modelOut = join(dist, "models");
  await mkdir(join(modelOut, "tokenizer"), { recursive: true });
  for (const name of MODEL_FILES) {
    await cp(join(MODEL_SRC, name), join(modelOut, name));
  }
  for (const name of TOKENIZER_FILES) {
    await cp(join(MODEL_SRC, "tokenizer", name), join(modelOut, "tokenizer", name));
  }
}

function optionsFor(entries, format) {
  return {
    entryPoints: Object.fromEntries(
      Object.entries(entries).map(([name, file]) => [name, join(root, file)]),
    ),
    outdir: dist,
    bundle: true,
    format,
    target: "chrome116",
    platform: "browser",
    splitting: false,
    sourcemap: watch ? "inline" : false,
    minify: !watch,
    logLevel: "info",
    // No Node externals: the only two runtime deps are onnxruntime-web (browser
    // build) and @huggingface/tokenizers (zero dependencies), so any attempt to
    // pull in a Node builtin is a real bug and should fail the build loudly.
    define: {
      "process.env.NODE_ENV": watch ? '"development"' : '"production"',
    },
  };
}

const builds = [
  optionsFor(CLASSIC_ENTRIES, "iife"),
  optionsFor(MODULE_ENTRIES, "esm"),
];

await rm(dist, { recursive: true, force: true });
await copyStatic();

if (watch) {
  for (const options of builds) {
    const ctx = await context(options);
    await ctx.watch();
  }
  console.log("[build] watching");
} else {
  await Promise.all(builds.map(build));
  console.log("[build] done -> dist/");
}
