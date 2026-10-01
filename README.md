# Tracecraft — image to vector

Turn any raster image into a clean, editable SVG vector. Built for the hard cases:
photos, logos, line art, and busy textiles such as dress patterns and prints — the
images most converters turn to mush.

## What it does

Upload an image, pick a preset, see the original and the traced SVG side by side,
download the `.svg`.

Presets:

- **Logo** — flat shapes and few colours, crisp edges.
- **Line art** — drawings, sketches, technical linework.
- **Photo** — continuous tone, higher colour counts, smoother curves.
- **Seamless pattern** — repeating prints and textiles: dress patterns, florals,
  geometric repeats.

No accounts, no stored files: an image is converted and then gone.

## Stack

- [TanStack Start](https://tanstack.com/start) (React + Vite + Tailwind), served
  with Bun on port 3000 — pages, server functions and API routes in one process.
- Tracing engine: a vtracer-class colour vectoriser (see `NOTES.md` for the choice
  and the preset parameters).

## Development

```bash
bun install
bun run dev      # dev server on 0.0.0.0:3000
bun run publish  # build and serve the live site on port 3000
```

Routes are files: `src/routes/<name>.tsx` becomes `/<name>`.
