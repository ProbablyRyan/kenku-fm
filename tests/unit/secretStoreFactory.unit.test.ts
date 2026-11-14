import fs from "fs/promises";
import path from "path";
import os from "os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCredentialId } from "../../src/dungeonJockey/domain/ids/CredentialId";

const { ready, available, encrypt, decrypt } = vi.hoisted(() => ({
  ready: vi.fn(async () => undefined),
  available: vi.fn(async () => true),
  encrypt: vi.fn(async () => Buffer.from("fake-ciphertext")),
  decrypt: vi.fn(async () => ({ result: "fake-credential", shouldReEncrypt: false })),
}));
vi.mock("electron", () => ({
  app: { whenReady: ready },
  safeStorage: { isAsyncEncryptionAvailable: available, encryptStringAsync: encrypt, decryptStringAsync: decrypt },
}));

const root = path.join(os.tmpdir(), "secret-store-factory-unused");
async function factory(platform: string, type = "browser") {
  vi.stubGlobal("process", { ...process, platform, type });
  return (await import("../../src/dungeonJockey/main/secretStore")).getApplicationSecretStore;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("main application secret store selection", () => {
  it("keeps Linux session-only without any disk or provider calls, and resets with the process", async () => {
    const disk = [vi.spyOn(fs, "lstat"), vi.spyOn(fs, "readFile"), vi.spyOn(fs, "mkdir"), vi.spyOn(fs, "open"), vi.spyOn(fs, "rename"), vi.spyOn(fs, "unlink")];
    const get = await factory("linux");
    const store = get(root);
    expect(get(root)).toBe(store);
    const result = await store.store("fake-credential");
    if (!result.ok) throw new Error("Session save failed");
    expect(result.persistence).toBe("session-only");
    expect(await store.status(result.id)).toEqual({ state: "available", persistence: "session-only" });
    expect(await store.use(result.id, () => undefined)).toMatchObject({ ok: true });
    expect(await store.replace(result.id, "fake-replacement")).toMatchObject({ ok: true });
    vi.resetModules();
    const restarted = (await factory("linux"))(root);
    expect(await restarted.status(result.id)).toEqual({ state: "missing", persistence: "session-only" });
    expect(await store.forget(result.id)).toMatchObject({ ok: true });
    for (const spy of [...disk, ready, available, encrypt, decrypt]) expect(spy).not.toHaveBeenCalled();
  });

  it.each(["win32", "darwin"])("waits for readiness before any %s native protection call", async (platform) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "secret-store-readiness-"));
    let release: () => void;
    ready.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    try {
      const get = await factory(platform);
      const store = get(temporary);
      const pending = store.store("fake-credential");
      await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
      expect(available).not.toHaveBeenCalled();
      expect(encrypt).not.toHaveBeenCalled();
      release();
      expect(await pending).toMatchObject({ ok: true, persistence: "remembered" });
      expect(get(temporary)).toBe(store);
      expect(() => get(path.join(temporary, "other"))).toThrow("profile is already selected");
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  });

  it("fails closed on unexpected platforms without storage or provider access", async () => {
    const read = vi.spyOn(fs, "lstat");
    const store = (await factory("freebsd"))(root);
    const id = parseCredentialId("00000000-0000-4000-8000-000000000001");
    expect(await store.store("fake")).toEqual({ ok: false, code: "SECRET_UNAVAILABLE" });
    expect(await store.status(id)).toMatchObject({ state: "unavailable", persistence: "unsupported" });
    expect(await store.forget(id)).toEqual({ ok: false, code: "SECRET_UNAVAILABLE" });
    expect(read).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(available).not.toHaveBeenCalled();
  });

  it("rejects renderer callers and nonabsolute profile paths", async () => {
    const get = await factory("win32", "renderer");
    expect(() => get(root)).toThrow("main process");
    vi.stubGlobal("process", { ...process, type: "browser" });
    expect(() => get("relative")).toThrow("absolute profile root");
  });
});
