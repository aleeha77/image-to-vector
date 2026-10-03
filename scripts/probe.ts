import sharp from "sharp";

const raw = Buffer.alloc(10 * 10 * 3, 200);
const png = await sharp(raw, { raw: { width: 10, height: 10, channels: 3 } }).png().toBuffer();
console.log("raw->png ok", png.length);
const meta = await sharp(png).metadata();
console.log("read png ok", meta.width, meta.height);
const out = await sharp(png).resize(40, 40, { kernel: "lanczos3" }).raw().toBuffer({ resolveWithObject: true });
console.log("resize ok", out.info.width, out.info.channels);

// Is SVG *input* the thing that hangs?
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#f00"/></svg>`;
console.log("rasterising svg...");
const t = setTimeout(() => {
  console.log("SVG-INPUT TIMED OUT (hangs)");
  process.exit(7);
}, 8000);
const svgPng = await sharp(Buffer.from(svg)).png().toBuffer();
clearTimeout(t);
console.log("svg raster ok", svgPng.length);
process.exit(0);
