/**
 * The one server entry point for conversion.
 *
 * A POST server function (not a GET handler) so an intermediary retrying a
 * request can never re-trigger tracing, and so the native vectoriser is only
 * ever imported on the server — `~/trace.server` is pulled in dynamically inside
 * the handler body, which the Start compiler strips from the client bundle.
 */
import { createServerFn } from "@tanstack/react-start";

export interface TraceRequest {
  /** `data:image/png;base64,...` — the browser's copy of the visitor's image. */
  dataUrl: string;
  preset: "logo" | "lineart" | "photo" | "pattern";
  /** 0 = simplest, 1 = most detail. */
  detail: number;
}

export interface TraceResponse {
  svg: string;
  width: number;
  height: number;
  pathCount: number;
  colourCount: number;
  bytes: number;
  ms: number;
  steps: string[];
}

const MAX_BYTES = 24 * 1024 * 1024;

/** Decode a data URL without ever touching the filesystem. */
function decodeDataUrl(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Malformed image payload");
  const header = dataUrl.slice(0, comma);
  if (!/^data:image\/(png|jpeg|jpg|webp|gif|avif|tiff);base64$/i.test(header)) {
    throw new Error("Unsupported image type — use PNG, JPG or WebP");
  }
  const buffer = Buffer.from(dataUrl.slice(comma + 1), "base64");
  if (buffer.length === 0) throw new Error("Empty image");
  if (buffer.length > MAX_BYTES) throw new Error("Image is too large (max 24 MB)");
  return buffer;
}

export const traceRaster = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as TraceRequest)
  .handler(async ({ data }): Promise<TraceResponse> => {
    const { traceImage } = await import("./trace.server");
    const buffer = decodeDataUrl(data.dataUrl);
    const result = await traceImage(buffer, {
      preset: data.preset,
      detail: data.detail,
    });
    return {
      svg: result.svg,
      width: result.width,
      height: result.height,
      pathCount: result.pathCount,
      colourCount: result.colourCount,
      bytes: result.bytes,
      ms: result.ms,
      steps: result.steps,
    };
  });
