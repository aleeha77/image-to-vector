/** Fast iteration: trace the four presets, save SVGs, render side-by-side full views. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { PRESET_IDS, traceImage, type PresetId } from "../src/trace.server";

const LAB = "/home/team/shared/trace-lab";
const FIX: Record<PresetId, string> = {
  lineart: "lineart-thin-diagonal.png",
  logo: "logo-flat.png",
  photo: "photo-portrait.jpg",
  pattern: "pattern-textile.png",
};
const wanted = (process.argv.slice(2).filter((a) => (PRESET_IDS as readonly string[]).includes(a)) as PresetId[]);
const only = wanted.length ? wanted : [...PRESET_IDS];
await mkdir(`${LAB}/svg`, { recursive: true });
for (const preset of only) {
  const input = await readFile(`${LAB}/fixtures/${FIX[preset]}`);
  const r = await traceImage(input, { preset, detail: 0.5 });
  await writeFile(`${LAB}/svg/${preset}.svg`, r.svg, "utf8");
  const src = await sharp(input).resize(700, 700, { fit: "inside" }).png().toBuffer();
  const sm = await sharp(src).metadata();
  const tr = await sharp(Buffer.from(r.svg), { density: 72 })
    .resize(700, 700, { fit: "inside" })
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
  const tm = await sharp(tr).metadata();
  const out = await sharp({
    create: { width: (sm.width ?? 0) + (tm.width ?? 0) + 15, height: Math.max(sm.height ?? 0, tm.height ?? 0) + 10, channels: 4, background: { r: 220, g: 40, b: 200, alpha: 1 } },
  })
    .composite([{ input: src, left: 5, top: 5 }, { input: tr, left: (sm.width ?? 0) + 10, top: 5 }])
    .png()
    .toBuffer();
  await writeFile(`${LAB}/_scratch/full-${preset}.png`, out);
  console.log(`${preset}: ${String(r.pathCount)} contours ${String((r.svg.match(/C/g) ?? []).length)} curves ${String(r.colourCount)} colours ${String((r.bytes / 1024).toFixed(0))}KB ${String(r.ms)}ms`);
  console.log(`   ${r.steps.join(" | ")}`);
}
