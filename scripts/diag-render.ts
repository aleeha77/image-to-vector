import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const file = process.argv[2] ?? "/home/team/shared/trace-lab/svg/pattern.svg";
const svg = await readFile(file, "utf8");
console.log("bytes", svg.length, "paths", (svg.match(/<path\b/g) ?? []).length, "M", (svg.match(/M/g) ?? []).length);
console.log("head:", svg.slice(0, 200));
const { data, info } = await sharp(Buffer.from(svg), { density: 72 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
console.log("render", info.width, "x", info.height, "ch", info.channels);
let unp = 0, tot = 0;
const bbox = [info.width, info.height, -1, -1];
const cols = new Map<number, number>();
for (let y = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 4;
    tot++;
    if (data[i + 3] < 8) {
      unp++;
      if (x < bbox[0]) bbox[0] = x;
      if (y < bbox[1]) bbox[1] = y;
      if (x > bbox[2]) bbox[2] = x;
      if (y > bbox[3]) bbox[3] = y;
      cols.set(x, (cols.get(x) ?? 0) + 1);
    }
  }
}
console.log(`unpainted ${unp}/${tot} = ${(unp / tot * 100).toFixed(2)}% bbox ${bbox.join(",")}`);
const byY = new Map<number, number>();
for (let y = 0; y < info.height; y++) { let c = 0; for (let x = 0; x < info.width; x++) if (data[(y * info.width + x) * 4 + 3] < 8) c++; if (c) byY.set(y, c); }
const rows = [...byY.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log("worst rows:", rows.map(([y, c]) => `y${y}:${c}`).join(" "));
const colsTop = [...cols.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log("worst cols:", colsTop.map(([x, c]) => `x${x}:${c}`).join(" "));
// visualization: unpainted -> magenta over the render
const vis = Buffer.alloc(info.width * info.height * 4);
for (let i = 0; i < info.width * info.height; i++) {
  const a = data[i * 4 + 3] / 255;
  for (let k = 0; k < 3; k++) vis[i * 4 + k] = Math.round(data[i * 4 + k] * a + 255 * (1 - a));
  vis[i * 4 + 3] = 255;
  if (data[i * 4 + 3] < 8) { vis[i * 4] = 255; vis[i * 4 + 1] = 0; vis[i * 4 + 2] = 255; }
}
await writeFile("/home/team/shared/trace-lab/evidence/gap-pattern.png", await sharp(vis, { raw: { width: info.width, height: info.height, channels: 4 } }).resize(700).png().toBuffer());
console.log("wrote /home/team/shared/trace-lab/evidence/gap-pattern.png");
