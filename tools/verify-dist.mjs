/**
 * Structural verification of a built `dist/`.
 *
 * Deliberately deterministic and browser-free, so it can gate every push. It
 * asserts the specific things that have actually broken during development, all
 * of which produce an extension that installs cleanly and then fails at runtime:
 *
 *  - a content script emitted as ESM instead of an IIFE (content scripts are
 *    classic scripts; a stray `import` makes them fail to execute at all)
 *  - a manifest referencing a file the build did not emit
 *  - a missing or corrupt model artifact
 *  - a missing ORT WASM binary, which ORT only discovers at session creation
 *  - a detector_meta.json whose invariants do not match the graph
 *
 * Runtime behaviour is NOT covered here. That needs a real browser and is
 * documented in README.md under "Verification status".
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

const failures = [];
const checks = [];

function check(name, fn) {
  try {
    const detail = fn();
    checks.push(`  ok    ${name}${detail ? ` (${detail})` : ""}`);
  } catch (err) {
    failures.push(`  FAIL  ${name}: ${err.message}`);
  }
}

function mustExist(relative) {
  const path = join(dist, relative);
  if (!existsSync(path)) throw new Error(`missing ${relative}`);
  return path;
}

if (!existsSync(dist)) {
  console.error("no dist/ — run `npm run build` first");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));

check("manifest is MV3", () => {
  if (manifest.manifest_version !== 3) {
    throw new Error(`manifest_version is ${manifest.manifest_version}`);
  }
  return `v${manifest.version}`;
});

check("service worker present and a module", () => {
  mustExist(manifest.background.service_worker);
  if (manifest.background.type !== "module") {
    throw new Error("background.type must be 'module' for an ESM bundle");
  }
  return manifest.background.service_worker;
});

check("popup and offscreen documents present", () => {
  mustExist(manifest.action.default_popup);
  const offscreen = readFileSync(mustExist("offscreen.html"), "utf8");
  const script = /src="([^"]+)"/.exec(offscreen)?.[1];
  if (!script) throw new Error("offscreen.html references no script");
  mustExist(script);
  return script;
});

check("both worlds are declared", () => {
  const worlds = manifest.content_scripts.map((c) => c.world);
  // The MAIN-world script is not cosmetic: it is the only context whose fetch
  // origin InnerTube accepts. Losing it silently disables all detection.
  for (const required of ["MAIN", "ISOLATED"]) {
    if (!worlds.includes(required)) throw new Error(`no ${required}-world content script`);
  }
  return worlds.join(" + ");
});

check("content scripts are classic scripts, not ESM", () => {
  for (const entry of manifest.content_scripts) {
    for (const file of entry.js) {
      const source = readFileSync(mustExist(file), "utf8");
      // A surviving import/export means esbuild emitted a module. Chrome cannot
      // execute that as a content script.
      // Static import/export only. Dynamic `import(...)` is legal in a classic
      // script, so flagging it would fail a valid build.
      const staticImport = /(^|[;}\s])import\s*(?:[A-Za-z_$*{]|["'])/;
      const staticExport = /(^|[;}\s])export\s*[A-Za-z_$*{]/;
      if (staticImport.test(source) || staticExport.test(source)) {
        throw new Error(`${file} contains static module syntax`);
      }
    }
    for (const file of entry.css ?? []) mustExist(file);
  }
  return manifest.content_scripts.flatMap((c) => c.js).join(", ");
});

check("CSP allows WASM", () => {
  const csp = manifest.content_security_policy?.extension_pages ?? "";
  if (!csp.includes("wasm-unsafe-eval")) {
    throw new Error("extension_pages CSP lacks 'wasm-unsafe-eval'; ORT cannot start");
  }
  return "wasm-unsafe-eval";
});

check("ORT WASM binaries shipped", () => {
  // ORT fetches these at session creation, so a missing file is invisible until
  // the first video.
  const names = [
    "ort/ort-wasm-simd-threaded.asyncify.wasm",
    "ort/ort-wasm-simd-threaded.asyncify.mjs",
  ];
  for (const name of names) mustExist(name);
  return `${names.length} files`;
});

check("model artifacts match models.json checksums", () => {
  const models = JSON.parse(readFileSync(join(root, "models.json"), "utf8"));
  let verified = 0;
  for (const file of models.files) {
    const path = join(dist, "models", file.path);
    if (!existsSync(path)) throw new Error(`missing models/${file.path}`);
    const bytes = readFileSync(path);
    if (bytes.byteLength !== file.bytes) {
      throw new Error(`models/${file.path} is ${bytes.byteLength} bytes, expected ${file.bytes}`);
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== file.sha256) throw new Error(`models/${file.path} checksum mismatch`);
    verified++;
  }
  return `${verified} files`;
});

check("variant manifest is shippable", () => {
  const manifest = JSON.parse(readFileSync(mustExist("variants.json"), "utf8"));
  const ids = Object.keys(manifest.variants);
  if (!ids.includes("base")) throw new Error("no 'base' variant");
  for (const [id, v] of Object.entries(manifest.variants)) {
    if (v.bundled) {
      // A bundled variant that is not actually in dist would fail only at the
      // first video, on the user's machine.
      mustExist(v.model);
      mustExist(v.meta);
    } else {
      // A remote variant without checksums cannot be verified after download,
      // and a bad graph degrades accuracy silently rather than crashing.
      for (const key of ["model", "meta"]) {
        const f = v.files?.[key];
        if (!f?.sha256 || !f?.bytes) throw new Error(`${id}.${key} lacks bytes/sha256`);
        if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error(`${id}.${key} bad sha256`);
      }
    }
  }
  return ids.join(", ");
});

check("detector metadata invariants", () => {
  const meta = JSON.parse(readFileSync(join(dist, "models", "detector_meta.json"), "utf8"));
  if (meta.labels.length !== 5) throw new Error(`${meta.labels.length} labels, expected 5`);
  if (meta.max_len !== 2048) throw new Error(`max_len ${meta.max_len}, graph is traced at 2048`);
  if (!(meta.threshold > 0 && meta.threshold < 1)) {
    throw new Error(`threshold ${meta.threshold} out of range`);
  }
  // Specials must survive vocabulary pruning or every window is malformed.
  for (const key of ["cls_token_id", "sep_token_id", "pad_token_id"]) {
    if (!meta.keep.includes(meta[key])) throw new Error(`${key} not in pruned vocabulary`);
  }
  if (meta.keep.length !== new Set(meta.keep).size) {
    throw new Error("keep contains duplicate ids");
  }
  return `${meta.keep.length} vocab rows, threshold ${meta.threshold}`;
});

console.log(checks.join("\n"));
if (failures.length > 0) {
  console.error(`\n${failures.join("\n")}\n\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`\n${checks.length} checks passed`);
