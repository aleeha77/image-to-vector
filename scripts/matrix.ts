/**
 * Smoke matrix: every fixture through every preset, with the structural facts.
 * Catches crashes, blow-ups in time/size, and raster-in-SVG regressions.
 */
import { readFile } from "node:fs/promises";
import { PRESET_IDS, traceImage, type PresetId } from "../src/trace.server";

const FIX = "/home/team/shared/trace-lab/fixtures";
const FILES = [
  "lineart-thin-diagonal.png",
  "logo-flat.png",
  "photo-portrait.jpg",
  "pattern-textile.png",
];

const only = process.argv[2] as PresetId | undefined;

for (const file of FILES) {
  const buf = await readFile(`${FIX}/${file}`);
  for (const preset of PRESET_IDS) {
    if (only && preset !== only) continue;
    const t0 = Date.now();
    try {
      const r = await traceImage(buf, { preset, detail: 0.5 });
      const hasImage = /<image\b/.test(r.svg);
      const hasBase64 = /base64/.test(r.svg);
      const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(r.svg);
      const sizeOk = vb?.[1] === String(r.width) && vb?.[2] === String(r.height);
      const nan = /NaN|Infinity/.test(r.svg);
      console.log(
        `${file.padEnd(26)} ${preset.padEnd(8)} ${String(r.width)}x${String(r.height)}  paths=${String(r.pathCount).padStart(5)}  colours=${String(r.colourCount).padStart(3)}  ${(r.bytes / 1024).toFixed(0).padStart(5)}KB  ${String(r.ms).padStart(5)}ms  img=${String(hasImage)} b64=${String(hasBase64)} vbOK=${String(sizeOk)} nan=${String(nan)} wall=${String(Date.now() - t0)}ms`,
      );
      if (nan) console.log("   !! NaN in path data");
      console.log(`   steps: ${r.steps.join(" | ")}`);
    } catch (e) {
      console.log(`${file} ${preset} FAILED after ${String(Date.now() - t0)}ms: ${(e as Error).message}`);
    }
  }
}
