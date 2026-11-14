// Isolated Electron main process fixture. Only fake credentials are used.
const fs = require("fs");
const path = require("path");
const os = require("os");
const ts = require("typescript");
const { app } = require("electron");

const [runRoot, phase] = process.argv.slice(2);
const relative = path.relative(os.tmpdir(), runRoot || "");
if (!relative || relative.startsWith("..") || path.isAbsolute(relative) ||
    !path.basename(runRoot).startsWith("dungeon-jockey-secret-probe-") ||
    !["save", "read"].includes(phase)) {
  app.exit(2);
} else {
  const profile = path.join(runRoot, "profile");
  fs.mkdirSync(path.join(profile, "Session Data"), { recursive: true });
  app.setPath("userData", profile);
  app.setPath("sessionData", path.join(profile, "Session Data"));
  app.setPath("crashDumps", runRoot);

  // Compile the actual adapter and factory in memory without production hooks or
  // generated build files. yarn verify separately typechecks these source files.
  require.extensions[".ts"] = (module, filename) => {
    const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: filename,
    });
    module._compile(output.outputText, filename);
  };

  const FAKE = "fake-native-secret-store-initial";
  const REPLACEMENT = "fake-native-secret-store-replacement";
  let stage = "ready";
  function check(condition) {
    if (!condition) throw new Error("Native probe assertion failed");
  }
  function report(result) {
    fs.writeFileSync(path.join(runRoot, `${phase}-result.json`), JSON.stringify({
      ...result, phase, pid: process.pid, electron: process.versions.electron,
      node: process.versions.node, uv: process.versions.uv,
      platform: process.platform, arch: process.arch,
    }));
  }

  app.whenReady().then(async () => {
    const { getApplicationSecretStore } = require("../../src/dungeonJockey/main/secretStore.ts");
    const store = getApplicationSecretStore(profile);
    const idFile = path.join(runRoot, "credential-id.json");
    let id;
    if (phase === "save") {
      stage = "save";
      const saved = await store.store(FAKE);
      check(saved.ok && saved.persistence === "remembered");
      id = saved.id;
      stage = "initial-use";
      let received = false;
      check((await store.use(id, (value) => { received = value === FAKE; })).ok && received);
      stage = "replace";
      check((await store.replace(id, REPLACEMENT)).ok);
      fs.writeFileSync(idFile, JSON.stringify({ id }));
    } else {
      id = JSON.parse(fs.readFileSync(idFile, "utf8")).id;
    }
    stage = "status";
    const status = await store.status(id);
    check(status.state === "available" && status.persistence === "remembered");
    stage = "use";
    let received = false;
    check((await store.use(id, (value) => { received = value === REPLACEMENT; })).ok && received);
    stage = "ciphertext";
    const directory = path.join(profile, "Protected Credentials");
    const files = fs.readdirSync(directory);
    check(files.length === 1 && files[0].endsWith(".json"));
    const contents = fs.readFileSync(path.join(directory, files[0]), "utf8");
    const ciphertext = Buffer.from(JSON.parse(contents).ciphertext, "base64");
    check(!contents.includes(FAKE) && !contents.includes(REPLACEMENT));
    check(!ciphertext.includes(Buffer.from(FAKE)) && !ciphertext.includes(Buffer.from(REPLACEMENT)));
    if (phase === "read") {
      stage = "forget";
      check((await store.forget(id)).ok);
      check((await store.status(id)).state === "missing");
    }
    report({ ok: true });
    app.exit(0);
  }).catch(() => {
    // Never print native errors, assertions containing values, or secret data.
    report({ ok: false, stage });
    app.exit(1);
  });
}
