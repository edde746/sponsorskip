/**
 * Download the model artifacts named in models.json into ./models.
 *
 * The weights are not in this repository for two reasons, one hard and one
 * deliberate. The hard one: detector_fp16.onnx is 116.4 MiB and GitHub refuses
 * any file over 100 MiB, so it could not be committed even with goodwill. The
 * deliberate one: this code is GPL-3.0 while the weights are CC BY-NC-SA 4.0
 * (inherited from the SponsorBlock database they were trained on), and keeping
 * them in separate artifacts keeps that split unambiguous.
 *
 * Every file is checked against a recorded size and SHA-256. A truncated or
 * substituted model would not crash -- it would quietly produce worse segments,
 * which is exactly the failure mode worth refusing to ship.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "models");

const manifest = JSON.parse(await readFile(join(root, "models.json"), "utf8"));

if (manifest.repo.startsWith("REPLACE_WITH")) {
  console.error(
    "models.json still has the placeholder repo id.\n" +
      "Set `repo` to the HuggingFace repo hosting the weights, e.g. \"yourname/sponsorskip-modernbert\".",
  );
  process.exit(1);
}

/** Already present and intact? Then skip the download. */
async function isCurrent(dest, file) {
  try {
    const info = await stat(dest);
    if (info.size !== file.bytes) return false;
    const hash = createHash("sha256").update(await readFile(dest)).digest("hex");
    return hash === file.sha256;
  } catch {
    return false;
  }
}

let downloaded = 0;
for (const file of manifest.files) {
  const dest = join(outDir, file.path);
  await mkdir(dirname(dest), { recursive: true });

  if (await isCurrent(dest, file)) {
    console.log(`[fetch] ok       ${file.path}`);
    continue;
  }

  const url = `https://huggingface.co/${manifest.repo}/resolve/${manifest.revision}/${file.path}`;
  process.stdout.write(`[fetch] get      ${file.path} … `);

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`\nHTTP ${res.status} for ${url}`);
    process.exit(1);
  }
  const body = Buffer.from(await res.arrayBuffer());

  const hash = createHash("sha256").update(body).digest("hex");
  if (body.byteLength !== file.bytes || hash !== file.sha256) {
    console.error(
      `\nintegrity check failed for ${file.path}\n` +
        `  expected ${file.bytes} bytes, sha256 ${file.sha256}\n` +
        `  received ${body.byteLength} bytes, sha256 ${hash}`,
    );
    process.exit(1);
  }

  // Write via a temp file so an interrupted run cannot leave a half model that
  // later passes a size check by coincidence.
  const tmp = `${dest}.partial`;
  await writeFile(tmp, body);
  await rename(tmp, dest);
  await unlink(tmp).catch(() => undefined);

  console.log(`${(body.byteLength / 1e6).toFixed(1)} MB verified`);
  downloaded++;
}

console.log(
  downloaded === 0
    ? "[fetch] all artifacts already present"
    : `[fetch] ${downloaded} artifact(s) downloaded into models/`,
);
