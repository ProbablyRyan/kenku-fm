import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPLICATION_CSP,
  APPLICATION_ENTRY,
  createApplicationProtocolHandler,
  registerApplicationScheme,
} from "../../src/dungeonJockey/main/applicationProtocol";

let temporaryRoot: string;
let root: string;
let handler: ReturnType<typeof createApplicationProtocolHandler>;
beforeEach(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "application-protocol-"));
  root = path.join(temporaryRoot, "main_window");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "index.html"), "<script src='../main_window/index.js'></script>");
  await fs.writeFile(path.join(root, "index.js"), "window.applicationLoaded = true;");
  await fs.writeFile(path.join(root, "preload.js"), "private preload");
  await fs.writeFile(path.join(root, "index.js.map"), "private source map");
  await fs.writeFile(path.join(root, "settings.json"), "private data");
  await fs.mkdir(path.join(temporaryRoot, "player_window"));
  await fs.writeFile(path.join(temporaryRoot, "player_window", "index.js"), "private player");
  handler = createApplicationProtocolHandler(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe("owned packaged application protocol", () => {
  it("enables standard storage, secure context and normal CORS without other privileges", () => {
    const protocol = { registerSchemesAsPrivileged: vi.fn() };
    registerApplicationScheme(protocol);
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledExactlyOnceWith([
      { scheme: "dungeon-jockey", privileges: { standard: true, secure: true, corsEnabled: true } },
    ]);
  });

  it.each([
    [APPLICATION_ENTRY, "text/html; charset=utf-8", "<script"],
    ["dungeon-jockey://app/main_window/index.js", "text/javascript; charset=utf-8", "window.applicationLoaded"],
  ])("serves only the declared build asset %s with CSP and MIME protection", async (url, type, content) => {
    const response = await handler({ url, method: "GET" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(type);
    expect(response.headers.get("Content-Security-Policy")).toBe(APPLICATION_CSP);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(await response.text()).toContain(content);
    const head = await handler({ url, method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe(type);
    expect(await head.text()).toBe("");
  });

  it.each([
    "https://app/index.html", "file:///index.html", "not a URL",
    "dungeon-jockey://other/index.html", "dungeon-jockey://app.evil/index.html",
    "dungeon-jockey://user@app/index.html", "dungeon-jockey://app:80/index.html",
    "dungeon-jockey://app/index.html?file=preload.js", "dungeon-jockey://app/index.html#x",
    "dungeon-jockey://app/", "dungeon-jockey://app/index.js",
    "dungeon-jockey://app/main_window/index.html", "dungeon-jockey://app/preload.js",
    "dungeon-jockey://app/main_window/preload.js", "dungeon-jockey://app/main_window/index.js.map",
    "dungeon-jockey://app/player_window/index.js", "dungeon-jockey://app/audio_capture_window/index.js",
    "dungeon-jockey://app/settings.json", "dungeon-jockey://app/userData/settings.json",
    "dungeon-jockey://app/../index.html", "dungeon-jockey://app/%2e%2e/index.html",
    "dungeon-jockey://app/%2e%2e%2fplayer_window/index.js",
    "dungeon-jockey://app/%252e%252e%252findex.html",
    "dungeon-jockey://app/main_window\\index.js", "dungeon-jockey://app/main_window%5cindex.js",
    "dungeon-jockey://app/C:/Windows/win.ini", "dungeon-jockey://app//server/share/file.js",
    "dungeon-jockey://app/index.html%00", "dungeon-jockey://app/index.html:stream",
    "dungeon-jockey://app/%69ndex.html", "dungeon-jockey://app/%ZZ",
    "dungeon-jockey://app/https://example.com/index.js",
  ])("fails closed without returning content for %s", async (url) => {
    const response = await handler({ url, method: "GET" });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "get"])("rejects %s", async (method) => {
    const response = await handler({ url: APPLICATION_ENTRY, method });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
    expect(await response.text()).toBe("");
  });

  it("fails closed for missing assets, directories and non-absolute roots", async () => {
    expect(() => createApplicationProtocolHandler("relative")).toThrow();
    await fs.unlink(path.join(root, "index.html"));
    expect((await handler({ url: APPLICATION_ENTRY, method: "GET" })).status).toBe(404);
    await fs.mkdir(path.join(root, "index.html"));
    expect((await handler({ url: APPLICATION_ENTRY, method: "GET" })).status).toBe(404);
  });

  it("rejects an allowed name whose canonical target escapes the root", async () => {
    await fs.unlink(path.join(root, "index.html"));
    // Windows junctions need no symlink privilege. A sibling-prefix directory
    // also catches containment checks implemented with a naive startsWith.
    const outside = path.join(temporaryRoot, "main_window-private");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, "index.html"), "junction");
    const open = vi.spyOn(fs, "open");
    expect((await handler({ url: APPLICATION_ENTRY, method: "GET" })).status).toBe(404);
    expect(open).not.toHaveBeenCalled();
  });
});
