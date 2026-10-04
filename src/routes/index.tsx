import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { traceRaster, type TraceResponse } from "~/convert";

export const Route = createFileRoute("/")({
  component: Converter,
});

type PresetId = "logo" | "lineart" | "photo" | "pattern";

const PRESETS: { id: PresetId; label: string; hint: string }[] = [
  { id: "logo", label: "Logo", hint: "Flat art, few colours, hard edges" },
  { id: "lineart", label: "Line art", hint: "Ink, pencil, sketches, stamps" },
  { id: "photo", label: "Photo", hint: "Many shades, gradients, soft edges" },
  { id: "pattern", label: "Seamless pattern", hint: "Textiles, dress prints, wallpaper" },
];

/** Longest edge we send to the server; the tracer works best at this scale. */
const MAX_UPLOAD_EDGE = 2000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface Loaded {
  name: string;
  width: number;
  height: number;
  previewUrl: string;
  dataUrl: string;
  type: string;
}

/** Read the file as-is — no canvas, no re-encode. */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { resolve(String(reader.result)); };
    reader.onerror = () => { reject(new Error("Could not read that file")); };
    reader.readAsDataURL(file);
  });
}
/**
 * Hand the server the best copy of the file we can.
 *
 * There is deliberately no canvas round-trip unless the image has to be shrunk:
 * drawing a photo through a canvas and re-encoding it as JPEG injects blocking
 * and edge ringing, and the tracer then faithfully reproduces those artefacts as
 * shapes. Below the size cap the original bytes go over untouched (the server
 * bakes in EXIF orientation with sharp `rotate()`), and anything we do have to
 * redraw is sent as PNG so the redraw itself stays lossless.
 */
async function prepareFile(file: File): Promise<Loaded> {
  const bitmap = await createImageBitmap(file);
  const long = Math.max(bitmap.width, bitmap.height);
  const scale = long > MAX_UPLOAD_EDGE ? MAX_UPLOAD_EDGE / long : 1;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  let dataUrl: string;
  let type = (file.type.split("/")[1] || "image").toUpperCase();
  if (scale === 1) {
    dataUrl = await fileToDataUrl(file);
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot read images");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    dataUrl = canvas.toDataURL("image/png");
    type = "PNG";
  }
  bitmap.close();
  if (dataUrl.length * 0.75 > MAX_UPLOAD_BYTES) throw new Error("Image is too large — try one under 10 MB");
  const previewUrl = URL.createObjectURL(file);
  return { name: file.name || "image", width, height, previewUrl, dataUrl, type };
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function Converter() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [preset, setPreset] = useState<PresetId>("pattern");
  const [detail, setDetail] = useState(0.6);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(TraceResponse & { svgUrl: string }) | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastSvgUrl = useRef<string | null>(null);

  useEffect(() => () => {
    if (lastSvgUrl.current) URL.revokeObjectURL(lastSvgUrl.current);
  }, []);

  const load = useCallback(async (file: File) => {
    setError(null);
    setResult(null);
    try {
      if (!file.type.startsWith("image/")) throw new Error("That is not an image file");
      setLoaded(await prepareFile(file));
    } catch (e) {
      setLoaded(null);
      setError(e instanceof Error ? e.message : "Could not read that file");
    }
  }, []);

  const run = useCallback(async () => {
    if (!loaded || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await traceRaster({ data: { dataUrl: loaded.dataUrl, preset, detail } });
      const svgUrl = URL.createObjectURL(new Blob([res.svg], { type: "image/svg+xml" }));
      if (lastSvgUrl.current) URL.revokeObjectURL(lastSvgUrl.current);
      lastSvgUrl.current = svgUrl;
      setResult({ ...res, svgUrl });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Tracing failed — try another image");
    } finally {
      setBusy(false);
    }
  }, [loaded, busy, preset, detail]);

  const download = () => {
    if (!result || !loaded) return;
    const stem = loaded.name.replace(/\.[^.]+$/, "") || "trace";
    const a = document.createElement("a");
    a.href = result.svgUrl;
    a.download = `${stem}.svg`;
    a.click();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void load(file);
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-8 px-5 py-10 text-slate-900">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 pb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tracecraft</h1>
          <p className="mt-1 text-sm text-slate-600">
            Raster image → clean, editable SVG. Colour separation and curve fitting, tuned for the hard cases:
            logos, line art, photos and busy textiles like dress prints.
          </p>
        </div>
        <p className="text-xs text-slate-500">No account. Nothing is stored — your image is traced and discarded.</p>
      </header>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* ---------------- input side ---------------- */}
        <div className="flex flex-col gap-5">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            className={`cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
              dragging ? "border-slate-900 bg-slate-50" : "border-slate-300 hover:border-slate-400"
            }`}
          >
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void load(file);
              }}
            />
            {loaded ? (
              <div className="flex flex-col items-center gap-3">
                <img src={loaded.previewUrl} alt="Uploaded" className="max-h-56 w-auto rounded-lg border border-slate-200" />
                <p className="text-xs text-slate-600">
                  {loaded.name} · {loaded.width}×{loaded.height} · {loaded.type}
                </p>
                <span className="text-xs font-medium underline">Choose a different image</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-10">
                <p className="text-sm font-medium">Drop an image here, or click to choose one</p>
                <p className="text-xs text-slate-500">PNG, JPG or WebP · up to 10 MB</p>
              </div>
            )}
          </div>

          <div>
            <h2 className="mb-2 text-sm font-semibold">Preset</h2>
            <div className="grid grid-cols-2 gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPreset(p.id)}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    preset === p.id
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-200 bg-white hover:border-slate-400"
                  }`}
                >
                  <span className="block text-sm font-medium">{p.label}</span>
                  <span className={`block text-[11px] ${preset === p.id ? "text-slate-300" : "text-slate-500"}`}>
                    {p.hint}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Detail</h2>
              <span className="text-xs text-slate-500">
                {detail < 0.34 ? "Simple, small file" : detail < 0.67 ? "Balanced" : "Maximum detail"}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={detail}
              onChange={(e) => setDetail(Number(e.target.value))}
              className="w-full accent-slate-900"
            />
            <div className="flex justify-between text-[11px] text-slate-500">
              <span>Fewer, cleaner shapes</span>
              <span>More colour layers &amp; small shapes</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void run()}
              disabled={!loaded || busy}
              className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {busy ? "Tracing…" : "Trace to SVG"}
            </button>
            {result && (
              <button
                type="button"
                onClick={download}
                className="rounded-lg border border-slate-900 px-5 py-2.5 text-sm font-medium"
              >
                Download .svg
              </button>
            )}
            {busy && <span className="text-xs text-slate-500">Large prints can take ~20 seconds.</span>}
          </div>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </div>

        {/* ---------------- output side ---------------- */}
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <figure className="flex flex-col gap-1">
              <figcaption className="text-xs font-semibold uppercase tracking-wide text-slate-500">Original</figcaption>
              <div className="flex h-64 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-[repeating-conic-gradient(#f1f5f9_0%_25%,#ffffff_0%_50%)] bg-[length:16px_16px]">
                {loaded ? (
                  <img src={loaded.previewUrl} alt="Original" className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="px-3 text-center text-xs text-slate-400">No image yet</span>
                )}
              </div>
            </figure>
            <figure className="flex flex-col gap-1">
              <figcaption className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Traced SVG
              </figcaption>
              <div className="flex h-64 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-[repeating-conic-gradient(#f1f5f9_0%_25%,#ffffff_0%_50%)] bg-[length:16px_16px]">
                {result ? (
                  // Rendered as an <img> on purpose: a 5–10k path SVG inlined into
                  // the page DOM makes the tab sluggish, an image does not.
                  <img src={result.svgUrl} alt="Traced vector" className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="px-3 text-center text-xs text-slate-400">
                    {busy ? "Tracing…" : "Choose a preset and trace"}
                  </span>
                )}
              </div>
            </figure>
          </div>

          {result ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                <div>
                  <dt className="text-slate-500">Paths</dt>
                  <dd className="font-medium tabular-nums">{result.pathCount.toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Colours</dt>
                  <dd className="font-medium tabular-nums">{result.colourCount.toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">SVG size</dt>
                  <dd className="font-medium tabular-nums">{fmtBytes(result.bytes)}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Traced in</dt>
                  <dd className="font-medium tabular-nums">{(result.ms / 1000).toFixed(1)}s</dd>
                </div>
              </dl>
              <p className="mt-2 border-t border-slate-200 pt-2 text-[11px] text-slate-500">
                {result.width}×{result.height} vector · {result.steps.join(" · ")}
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-xs text-slate-500">
              <p className="font-medium text-slate-700">What comes out</p>
              <p className="mt-1">
                A scalable SVG of real paths and flat colour layers — editable in Illustrator, Figma, Affinity or
                Inkscape, not a bitmap wrapped in an SVG.
              </p>
            </div>
          )}
        </div>
      </section>

      <footer className="mt-auto border-t border-slate-200 pt-4 text-xs text-slate-500">
        Tracing runs server-side on vtracer (colour clustering + spline fitting), with a per-preset preprocessing
        pass: upscaling, despeckling, colour shaping and transparency flattening. Nothing is written to disk.
      </footer>
    </main>
  );
}
