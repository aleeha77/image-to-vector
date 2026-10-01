// Vercel Build Output API function entry.
//
// The Build Output Node launcher invokes the default export as a classic Node
// `(req, res)` handler — NOT a web handler. TanStack Start emits a portable web
// fetch handler (dist/server/server.js), so we adapt: Node IncomingMessage → web
// Request, run the fetch handler, stream the web Response back onto ServerResponse.
// Node 22 has global Request/Response/Headers/ReadableStream.
//
// Bundled (with its deps + the SSR handler's dynamic ./assets chunks) into
// .vercel/output/functions/render.func/index.mjs by build-vercel.sh.
import type { IncomingMessage, ServerResponse } from "node:http";

import handler from "./dist/server/server.js";

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the built server entry default-exports a fetch handler, and the dist import is untyped.
const fetchHandler = handler as {
  fetch: (request: Request) => Response | Promise<Response>;
};

const toWebRequest = (req: IncomingMessage): Request => {
  const host = req.headers.host ?? "localhost";
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = typeof forwardedProto === "string" ? forwardedProto : "https";
  const url = `${proto}://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else if (value !== undefined) headers.set(key, value);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Node's fetch takes any async iterable as a body and IncomingMessage is one; the DOM typings only name ReadableStream.
  const body = req as unknown as ReadableStream;
  // `duplex` is required by Node for a streamed body and missing from the DOM typings.
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    ...(hasBody ? { body, duplex: "half" as const } : {}),
  };
  return new Request(url, init);
};

export default async function vercelHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const webRes = await fetchHandler.fetch(toWebRequest(req));
    res.statusCode = webRes.status;
    webRes.headers.forEach((value, key) => res.setHeader(key, value));
    if (webRes.body) {
      const reader = webRes.body.getReader();
      let chunk = await reader.read();
      while (!chunk.done) {
        res.write(chunk.value);
        chunk = await reader.read();
      }
    }
    res.end();
  } catch (error) {
    // Log the detail server-side (captured by the host's function logs); never
    // return a stack trace to the public visitor of the site.
    console.error("[team-site] SSR request failed", error);
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain");
    res.end("Internal Server Error");
  }
}
