/**
 * Builds the trace-lab fixtures.
 *
 * Three are synthetic (authored here as SVG and rasterised with sharp/librsvg) so
 * that we also have an exact vector ground truth to measure against. The
 * photograph is a real JPEG downloaded from Lorem Picsum (https://picsum.photos,
 * images served from Unsplash) — see FIXTURE-SOURCES.md.
 */
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";

const OUT = "/home/team/shared/trace-lab/fixtures";
await mkdir(OUT, { recursive: true });

const lineart = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900" viewBox="0 0 1400 900">
  <rect width="1400" height="900" fill="#ffffff"/>
  <g fill="none" stroke="#111111" stroke-linecap="round">
    <circle cx="300" cy="285" r="180" stroke-width="2.4"/>
    <circle cx="300" cy="285" r="120" stroke-width="1.6"/>
    <line x1="760" y1="120" x2="1300" y2="660" stroke-width="2"/>
    <line x1="1300" y1="120" x2="760" y2="660" stroke-width="2"/>
    <path d="M120 780 C 300 600, 520 830, 760 700 S 1120 560, 1330 720" stroke-width="2.2"/>
    <path d="M980 250 L 1180 250 L 1180 450 L 980 450 Z" stroke-width="1.8"/>
  </g>
  <text x="120" y="120" font-family="DejaVu Sans, Helvetica, sans-serif" font-size="72" fill="#111111">Trace me</text>
  <text x="790" y="820" font-family="DejaVu Sans, Helvetica, sans-serif" font-size="34" fill="#444444">thin strokes 2px</text>
  <g stroke="#111111" stroke-width="1.2">
    <line x1="640" y1="180" x2="700" y2="180"/><line x1="640" y1="200" x2="700" y2="200"/>
    <line x1="640" y1="220" x2="700" y2="220"/><line x1="640" y1="240" x2="700" y2="240"/>
    <line x1="640" y1="260" x2="700" y2="260"/><line x1="640" y1="280" x2="700" y2="280"/>
  </g>
</svg>`;

const logo = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200">
  <rect width="1200" height="1200" fill="#ffffff"/>
  <g>
    <path d="M600 90 L 1050 350 L 1050 850 L 600 1110 L 150 850 L 150 350 Z" fill="#1b3a5c"/>
    <path d="M600 190 L 960 400 L 960 800 L 600 1010 L 240 800 L 240 400 Z" fill="#ffffff"/>
    <circle cx="600" cy="600" r="250" fill="#e8b21e"/>
    <path d="M600 400 A 200 200 0 0 1 600 800 Z" fill="#c0392b"/>
    <path d="M600 400 A 200 200 0 0 0 600 800 Z" fill="#2c7a4b"/>
    <circle cx="600" cy="600" r="70" fill="#ffffff"/>
    <rect x="240" y="1090" width="720" height="40" fill="#1b3a5c"/>
  </g>
  <text x="600" y="180" text-anchor="middle" font-family="DejaVu Sans, Helvetica, sans-serif" font-weight="bold" font-size="96" fill="#1b3a5c">ACME</text>
</svg>`;

const pattern = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1400" viewBox="0 0 1400 1400">
  <rect width="1400" height="1400" fill="#f6efe3"/>
  <g fill="none" stroke="#7a4a2b" stroke-width="1">
    <path d="M0 175 C 175 75, 350 275, 525 175 S 875 75, 1050 175 S 1400 275, 1400 175"/>
    <path d="M0 525 C 175 425, 350 625, 525 525 S 875 425, 1050 525 S 1400 625, 1400 525"/>
    <path d="M0 875 C 175 775, 350 975, 525 875 S 875 775, 1050 875 S 1400 975, 1400 875"/>
    <path d="M0 1225 C 175 1125, 350 1325, 525 1225 S 875 1125, 1050 1225 S 1400 1325, 1400 1225"/>
  </g>
  <g fill="#3b6ea5">
    <circle cx="175" cy="350" r="9"/><circle cx="525" cy="350" r="7"/><circle cx="875" cy="350" r="9"/><circle cx="1225" cy="350" r="7"/>
    <circle cx="175" cy="700" r="7"/><circle cx="525" cy="700" r="9"/><circle cx="875" cy="700" r="7"/><circle cx="1225" cy="700" r="9"/>
    <circle cx="175" cy="1050" r="9"/><circle cx="525" cy="1050" r="7"/><circle cx="875" cy="1050" r="9"/><circle cx="1225" cy="1050" r="7"/>
  </g>
  <g fill="#c0392b">
    <g id="motif">
      <path d="M350 175 q 40 -55 80 0 q -40 55 -80 0 Z"/>
      <path d="M700 175 q 40 -55 80 0 q -40 55 -80 0 Z"/>
      <path d="M1050 175 q 40 -55 80 0 q -40 55 -80 0 Z"/>
    </g>
    <use href="#motif" y="350"/>
    <use href="#motif" y="700"/>
    <use href="#motif" y="1050"/>
  </g>
  <g stroke="#2b7a4b" stroke-width="1" fill="none">
    <rect x="230" y="230" width="90" height="90" transform="rotate(15 275 275)"/>
    <rect x="580" y="230" width="90" height="90" transform="rotate(15 625 275)"/>
    <rect x="930" y="230" width="90" height="90" transform="rotate(15 975 275)"/>
    <rect x="230" y="930" width="90" height="90" transform="rotate(15 275 975)"/>
    <rect x="580" y="930" width="90" height="90" transform="rotate(15 625 975)"/>
    <rect x="930" y="930" width="90" height="90" transform="rotate(15 975 975)"/>
  </g>
  <g fill="#8a6a3a">
    <circle cx="80" cy="880" r="4"/><circle cx="120" cy="920" r="4"/><circle cx="160" cy="960" r="4"/>
    <circle cx="200" cy="1000" r="4"/><circle cx="240" cy="1040" r="4"/><circle cx="280" cy="1080" r="4"/>
    <circle cx="1140" cy="120" r="4"/><circle cx="1180" cy="160" r="4"/><circle cx="1220" cy="200" r="4"/>
    <circle cx="1260" cy="240" r="4"/><circle cx="1300" cy="280" r="4"/><circle cx="1340" cy="320" r="4"/>
  </g>
</svg>`;

async function raster(svg: string, name: string) {
  const buf = await sharp(Buffer.from(svg), { density: 72 }).png({ compressionLevel: 9 }).toBuffer();
  await writeFile(`${OUT}/${name}`, buf);
  const m = await sharp(buf).metadata();
  console.log(`${name}  ${String(m.width)}x${String(m.height)}  ${String(buf.length)} bytes`);
}

await raster(lineart, "lineart-thin-diagonal.png");
await raster(logo, "logo-flat.png");
await raster(pattern, "pattern-textile.png");
await writeFile(`${OUT}/lineart-source.svg`, lineart);
await writeFile(`${OUT}/logo-source.svg`, logo);
await writeFile(`${OUT}/pattern-source.svg`, pattern);

// Real photograph (Lorem Picsum -> Unsplash). Kept as a genuine JPEG so the
// JPEG-artefact hypothesis (H2) is exercised by the fixture, not just by prose.
const res = await fetch("https://picsum.photos/seed/tracecraft/1024/768.jpg");
if (!res.ok) throw new Error(`photo download failed: ${String(res.status)}`);
const jpg = Buffer.from(await res.arrayBuffer());
await writeFile(`${OUT}/photo-portrait.jpg`, jpg);
console.log(`photo-portrait.jpg  ${String(jpg.length)} bytes`);
