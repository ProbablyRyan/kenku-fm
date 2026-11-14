// Run with the pinned Node: node tests/native/protected-secret-store.cjs
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const electron = require("electron");
const runtime = require("electron/package.json").version;
const fixture = path.resolve(__dirname, "../fixtures/protected-secret-store.cjs");
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dungeon-jockey-secret-probe-"));
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

try {
  if (process.platform !== "win32" && process.platform !== "darwin") {
    throw new Error("Native protected storage probe requires Windows or macOS");
  }
  if (runtime !== "43.0.0+wvcus") throw new Error("Unexpected Electron package version");
  console.log(JSON.stringify({ runtime, executable: electron, profile: path.join(runRoot, "profile") }));
  const results = [];
  for (const phase of ["save", "read"]) {
    const child = spawnSync(electron, [fixture, runRoot, phase], {
      env: environment, encoding: "utf8", windowsHide: true, timeout: 45000,
    });
    // Child stdout/stderr are deliberately not forwarded. Reports contain only
    // fixed probe stages, runtime versions, PIDs, and non-secret outcomes.
    if (child.error || child.status !== 0) {
      const reportPath = path.join(runRoot, `${phase}-result.json`);
      const result = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : undefined;
      console.error(JSON.stringify({ phase, status: child.status, signal: child.signal, code: child.error?.code, result }));
      throw new Error("Native secret store probe failed");
    }
    const result = JSON.parse(fs.readFileSync(path.join(runRoot, `${phase}-result.json`), "utf8"));
    if (!result.ok) throw new Error("Native secret store probe failed");
    results.push(result);
    console.log(JSON.stringify(result));
  }
  if (results[0].pid === results[1].pid) throw new Error("Restart probe did not use distinct processes");
  console.log("PASS: asynchronous native save, replace, restart, use, ciphertext and forget");
} catch (error) {
  // All runner errors above are fixed messages; never output child errors.
  console.error(error instanceof Error && error.message.startsWith("Native")
    ? error.message : "Native secret store probe could not complete");
  process.exitCode = 1;
} finally {
  const relative = path.relative(os.tmpdir(), runRoot);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) ||
      !path.basename(runRoot).startsWith("dungeon-jockey-secret-probe-")) {
    throw new Error("Refusing cleanup outside the isolated native probe directory");
  }
  fs.rmSync(runRoot, { recursive: true, force: true });
  console.log(`Native probe cleanup verified: ${!fs.existsSync(runRoot)}`);
}
