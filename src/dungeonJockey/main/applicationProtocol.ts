import { promises as fs } from "fs";
import path from "path";
import type { Protocol, Session } from "electron";

export const APPLICATION_SCHEME = "dungeon-jockey";
export const APPLICATION_ENTRY = "dungeon-jockey://app/index.html";

// Emotion/MUI, style-loader and React style attributes require inline styles.
// Website favicons/bookmarks and Discord guild icons remain image-only sources.
// No inline/eval scripts, connections, frames, workers or media in the app UI.
export const APPLICATION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https: http:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function registerApplicationScheme(
  protocol: Pick<Protocol, "registerSchemesAsPrivileged">,
): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APPLICATION_SCHEME,
      privileges: { standard: true, secure: true, corsEnabled: true },
    },
  ]);
}

// Forge's HTML references ../main_window/index.js. The application currently
// has no separate CSS, fonts, images or lazy chunks. Add future build assets
// explicitly here; never expose the renderer output tree or preload bundle.
const assets = new Map([
  ["/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/main_window/index.js", { file: "index.js", type: "text/javascript; charset=utf-8" }],
]);

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Main selects the packaged main_window directory, never a renderer argument. */
export function createApplicationProtocolHandler(root: string) {
  if (!path.isAbsolute(root)) throw new Error("Application asset root must be absolute");
  const selectedRoot = path.resolve(root);
  return async (request: Pick<Request, "url" | "method">): Promise<Response> => {
    const headers = {
      "Content-Security-Policy": APPLICATION_CSP,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "no-store",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    }
    try {
      const url = new URL(request.url);
      const asset = assets.get(url.pathname);
      // Reject alternate spellings, encodings, credentials, ports and queries.
      // No user-supplied string ever becomes a filesystem path.
      if (!asset || request.url !== `${APPLICATION_SCHEME}://app${url.pathname}`) {
        return new Response(null, { status: 404, headers });
      }
      const canonicalRoot = await fs.realpath(selectedRoot);
      const candidate = path.resolve(selectedRoot, asset.file);
      const canonicalFile = await fs.realpath(candidate);
      if (!isInside(selectedRoot, candidate) || !isInside(canonicalRoot, canonicalFile)) {
        return new Response(null, { status: 404, headers });
      }
      const file = await fs.open(canonicalFile, "r");
      try {
        if (!(await file.stat()).isFile()) return new Response(null, { status: 404, headers });
        const body = request.method === "HEAD" ? null : new Uint8Array(await file.readFile());
        return new Response(body, { headers: { ...headers, "Content-Type": asset.type } });
      } finally {
        await file.close();
      }
    } catch {
      // Do not disclose local paths, filesystem errors or fallback content.
      return new Response(null, { status: 404, headers });
    }
  };
}

export function installApplicationProtocol(session: Session, root: string): void {
  session.protocol.handle(APPLICATION_SCHEME, createApplicationProtocolHandler(root));
}
