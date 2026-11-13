import fs from "fs";
import http from "http";
import path from "path";
import childProcess from "child_process";
import { AddressInfo } from "net";
import {
  _electron as electron,
  ElectronApplication,
  Page,
  expect,
  test,
} from "@playwright/test";

import productIdentity from "../../product-identity.json";
import packageMetadata from "../../package.json";
import { APPLICATION_CSP, APPLICATION_ENTRY } from "../../src/dungeonJockey/main/applicationProtocol";

type ProbeFacts = {
  pcmFrameCount: number;
  peakAbsoluteSample: number;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function serveFixture(): Promise<{
  close: () => Promise<void>;
  url: string;
}> {
  const fixture = fs.readFileSync(
    path.resolve(__dirname, "../fixtures/browser-audio.html"),
  );
  const server = http.createServer((request, response) => {
    if (request.url !== "/browser-audio.html") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
    });
    response.end(fixture);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}/browser-audio.html`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) =>
              error ? closeReject(error) : closeResolve(),
            );
          }),
      });
    });
  });
}

test("packaged app captures non-silent PCM from a loopback browser fixture", async () => {
  test.skip(process.platform !== "win32" || process.arch !== "x64");

  requiredEnvironment("DUNGEON_JOCKEY_E2E_OUTPUT");
  const packageDirectory = requiredEnvironment("DUNGEON_JOCKEY_E2E_PACKAGE");
  const profilePath = requiredEnvironment("DUNGEON_JOCKEY_E2E_PROFILE");
  const executablePath = path.join(
    packageDirectory,
    `${productIdentity.packageName}.exe`,
  );
  const applicationEntryPath = path.resolve(
    packageDirectory,
    "resources", "app", ".webpack", "renderer", "main_window", "index.html",
  );
  const applicationEntryUrl = APPLICATION_ENTRY;

  expect(fs.statSync(executablePath).isFile()).toBe(true);
  expect(fs.existsSync(`${executablePath}.sig`)).toBe(false);

  const metadataCommand = [
    "$v=(Get-Item -LiteralPath $env:DUNGEON_JOCKEY_METADATA_EXE).VersionInfo;",
    "[Console]::Out.Write(($v | Select-Object ProductName,FileDescription,OriginalFilename | ConvertTo-Json -Compress))",
  ].join("");
  const metadata = JSON.parse(
    childProcessOutput(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ["-NoProfile", "-Command", metadataCommand],
      { DUNGEON_JOCKEY_METADATA_EXE: executablePath },
    ),
  );
  expect(metadata.ProductName).toBe(productIdentity.displayName);
  expect(metadata.FileDescription).toBe(productIdentity.displayName);
  expect(metadata.OriginalFilename).toBe(`${productIdentity.packageName}.exe`);

  const fixture = await serveFixture();
  const processErrors: string[] = [];
  const rendererErrors: string[] = [];
  const mainConsoleErrors: string[] = [];
  const rendererConsoleErrors: string[] = [];
  const observedWindowUrls = new Set<string>();
  const observedWindows = new Set<Page>();
  let application: ElectronApplication | undefined;
  let cleanExitCode: number | null = null;

  const launch = async () => {
    const launchedApplication = await electron.launch({
      executablePath,
      env: {
        ...process.env,
        DUNGEON_JOCKEY_AUDIO_SMOKE_PROBE: "main-pcm-v1",
        DUNGEON_JOCKEY_TEST_PROFILE: profilePath,
      },
    });
    application = launchedApplication;
    launchedApplication.process().stderr?.on("data", (chunk) => {
      processErrors.push(String(chunk));
    });
    launchedApplication.on("console", (message) => {
      if (message.type() === "error") mainConsoleErrors.push(message.text());
    });
    const observeWindow = (page: Page) => {
      if (observedWindows.has(page)) return;
      observedWindows.add(page);
      observedWindowUrls.add(page.url());
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) observedWindowUrls.add(frame.url());
      });
      page.on("crash", () =>
        rendererErrors.push(`${page.url()}: renderer crashed`),
      );
      page.on("pageerror", (error) =>
        rendererErrors.push(`${page.url()}: ${error.message}`),
      );
      page.on("console", (message) => {
        if (message.type() === "error") {
          rendererConsoleErrors.push(`${page.url()}: ${message.text()}`);
        }
      });
    };
    launchedApplication.on("window", observeWindow);
    launchedApplication.windows().forEach(observeWindow);

    return launchedApplication;
  };

  const findApplicationWindow = async (launchedApplication: ElectronApplication) => {
    // Hidden capture windows can load before the application UI. Poll current
    // pages as well as newly created ones, including pages initially about:blank.
    let mainWindow: Page | undefined;
    await expect
      .poll(() => {
        const windows = launchedApplication.windows();
        windows.forEach((page) => observedWindowUrls.add(page.url()));
        mainWindow = windows.find((page) => page.url() === applicationEntryUrl);
        return mainWindow !== undefined;
      }, {
        timeout: 30_000,
        message: `Waiting for packaged application entry: ${applicationEntryUrl}`,
      })
      .toBe(true);
    await expect(mainWindow.getByRole("button", { name: "add tab" })).toBeVisible();
    await expect(mainWindow.getByLabel("Dungeon Jockey temporary mark")).toBeVisible();
    await expect(mainWindow.getByText("Oops, something went wrong..")).toHaveCount(0);
    return mainWindow;
  };

  const closeApplication = async () => {
    if (!application) return;
    const applicationProcess = application.process();
    await application.close();
    cleanExitCode = applicationProcess.exitCode;
    application = undefined;
    expect(cleanExitCode).toBe(0);
  };

  try {
    const launchedApplication = await launch();
    const mainWindow = await findApplicationWindow(launchedApplication);
    expect(await mainWindow.evaluate(() => ({
      origin: location.origin,
      secure: isSecureContext,
      scripts: Array.from(document.scripts, (script) => script.src),
    }))).toEqual({
      origin: "dungeon-jockey://app",
      secure: true,
      scripts: ["dungeon-jockey://app/main_window/index.js"],
    });

    const runtimeIdentity = await launchedApplication.evaluate(({ app }) => ({
      appName: app.getName(),
      executableName: process.execPath.split(/[\\/]/).pop(),
      isPackaged: app.isPackaged,
      userData: app.getPath("userData"),
    }));
    expect(runtimeIdentity).toEqual({
      appName: productIdentity.displayName,
      executableName: `${productIdentity.packageName}.exe`,
      isPackaged: true,
      userData: profilePath,
    });

    // Change a harmless preference through the real Redux UI. Do not seed or
    // copy a legacy persisted root (which could include credentials).
    await mainWindow.getByTestId("SettingsRoundedIcon").click();
    const multipleOutputs = mainWindow.getByRole("checkbox", { name: "Multiple Outputs", exact: true });
    await expect(multipleOutputs).not.toBeChecked();
    await multipleOutputs.check();
    await mainWindow.getByRole("button", { name: "Done", exact: true }).click();
    await expect.poll(() => readFixturePreferences(mainWindow)).toEqual({
      multipleOutputsEnabled: true,
      bookmarks: [],
    });

    // Exercise the real isolated preload and guarded main handler on both
    // documents, not a main-process shortcut to app.getVersion().
    for (const reload of [false, true]) {
      if (reload) {
        const response = await mainWindow.reload();
        expect(response?.status()).toBe(200);
        expect(response?.headers()["content-security-policy"]).toBe(APPLICATION_CSP);
        await expect(
          mainWindow.getByRole("button", { name: "add tab" }),
        ).toBeVisible();
      }
      const versionResult = await mainWindow.evaluate(() =>
        window.dungeonJockey.getVersion(),
      );
      expect(versionResult).toEqual({
        ok: true,
        protocolVersion: 1,
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        version: packageMetadata.version,
      });
      expect(
        await mainWindow.evaluate(() => Object.keys(window.dungeonJockey)),
      ).toEqual(["getVersion"]);
      expect(await mainWindow.evaluate(() => "version" in window.kenku)).toBe(
        false,
      );
      await mainWindow.getByTestId("SettingsRoundedIcon").click();
      await expect(multipleOutputs).toBeChecked();
      await expect(
        mainWindow.getByText(`v${packageMetadata.version}`, { exact: true }),
      ).toBeVisible();
      await mainWindow
        .getByRole("button", { name: "Done", exact: true })
        .click();
    }

    await mainWindow.getByRole("button", { name: "add tab" }).click();
    const urlInput = mainWindow.getByRole("textbox", { name: "enter a URL" });
    await expect(urlInput).toBeVisible();
    await urlInput.fill(fixture.url);
    await urlInput.press("Enter");

    await expect
      .poll(() =>
        launchedApplication.evaluate(({ webContents }, fixtureUrl) =>
          webContents
            .getAllWebContents()
            .some((contents) => contents.getURL() === fixtureUrl),
          fixture.url,
        ),
      )
      .toBe(true);

    const fixtureTitle = "Dungeon Jockey browser audio fixture";
    await expect(mainWindow.getByText(fixtureTitle, { exact: true })).toBeVisible();
    await mainWindow.getByRole("button", { name: "bookmark", exact: true }).click();
    const expectedPreferences = {
      multipleOutputsEnabled: true,
      bookmarks: [{ url: fixture.url, title: fixtureTitle }],
    };
    await expect.poll(() => readFixturePreferences(mainWindow)).toEqual(expectedPreferences);

    const fixtureHasOwnedBridge = await launchedApplication.evaluate(
      async ({ webContents }, fixtureUrl) => {
        const contents = webContents
          .getAllWebContents()
          .find((item) => item.getURL() === fixtureUrl);
        if (!contents) throw new Error("loopback fixture tab was not found");
        return contents.executeJavaScript("'dungeonJockey' in window");
      },
      fixture.url,
    );
    expect(fixtureHasOwnedBridge).toBe(false);

    await launchedApplication.evaluate(() => {
      const surface = (
        globalThis as unknown as Record<string, { reset: () => void }>
      )["__DUNGEON_JOCKEY_AUDIO_SMOKE_PROBE__"];
      if (!surface) throw new Error("main-process PCM probe is unavailable");
      surface.reset();
    });

    await expect
      .poll(async () => (await readProbe(launchedApplication)).pcmFrameCount, {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    const silentFacts = await readProbe(launchedApplication);
    expect(silentFacts.peakAbsoluteSample).toBe(0);

    const started = await launchedApplication.evaluate(async ({ webContents }, fixtureUrl) => {
      const fixtureContents = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === fixtureUrl);
      if (!fixtureContents) throw new Error("loopback fixture tab was not found");
      return fixtureContents.executeJavaScript(
        "window.startDeterministicTone().then(() => document.getElementById('state').textContent)",
        true,
      );
    }, fixture.url);
    expect(started).toBe("tone-started");

    await expect
      .poll(async () => (await readProbe(launchedApplication)).peakAbsoluteSample, {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    const audibleFacts = await readProbe(launchedApplication);
    expect(audibleFacts.pcmFrameCount).toBeGreaterThan(silentFacts.pcmFrameCount);

    const crashed = await launchedApplication.evaluate(({ webContents }) =>
      webContents.getAllWebContents().some((contents) => contents.isCrashed()),
    );
    expect(crashed).toBe(false);
    expect(rendererErrors).toEqual([]);
    expect(processErrors.join("")).not.toMatch(/fatal|uncaught|unhandled/i);

    console.log(
      JSON.stringify({
        audibleFacts,
        executablePath,
        fixtureUrl: fixture.url,
        packageIdentity: runtimeIdentity,
        silentFacts,
      }),
    );

    // Reload proves both Redux-persist slices rehydrate, then a clean process
    // restart proves durability in the same isolated profile and owned origin.
    await mainWindow.reload();
    await expect(mainWindow.getByRole("button", { name: "add tab" })).toBeVisible();
    await expect(mainWindow.getByText(fixtureTitle, { exact: true })).toBeVisible();
    await expect.poll(() => readFixturePreferences(mainWindow)).toEqual(expectedPreferences);
    await closeApplication();
    const restartedApplication = await launch();
    const restartedWindow = await findApplicationWindow(restartedApplication);
    expect(await restartedApplication.evaluate(({ app }) => app.getPath("userData"))).toBe(profilePath);
    await expect(restartedWindow.getByText(fixtureTitle, { exact: true })).toBeVisible();
    await restartedWindow.getByTestId("SettingsRoundedIcon").click();
    await expect(restartedWindow.getByRole("checkbox", { name: "Multiple Outputs", exact: true })).toBeChecked();
    await expect(restartedWindow.getByText(`v${packageMetadata.version}`, { exact: true })).toBeVisible();
    await expect.poll(() => readFixturePreferences(restartedWindow)).toEqual(expectedPreferences);
    expect(await restartedWindow.evaluate(() => window.dungeonJockey.getVersion())).toMatchObject({
      ok: true, version: packageMetadata.version,
    });
    expect(rendererErrors).toEqual([]);
    expect(processErrors.join("")).not.toMatch(/fatal|uncaught|unhandled/i);
    const applicationCspErrors = rendererConsoleErrors.filter((message) =>
      message.startsWith(applicationEntryUrl) && /content.security.policy|violat.*directive/i.test(message),
    );
    expect(applicationCspErrors).toEqual([]);
    console.log("Owned-origin settings and bookmarks survived reload and clean restart");
  } catch (error) {
    // Print before cleanup: the runner removes temporary Playwright artifacts.
    console.error(
      "Packaged smoke failure diagnostics:",
      JSON.stringify({
        expectedApplicationUrl: applicationEntryUrl,
        expectedApplicationPath: applicationEntryPath,
        observedWindowUrls: [...observedWindowUrls],
        currentWindowUrls: application?.windows().map((page) => page.url()) ?? [],
        processErrors,
        mainConsoleErrors,
        rendererErrors,
        rendererConsoleErrors,
        failure: error instanceof Error ? error.stack : String(error),
      }, null, 2),
    );
    throw error;
  } finally {
    try {
      await closeApplication();
    } finally {
      await fixture.close();
    }
  }

  expect(cleanExitCode).toBe(0);
  expect(fs.existsSync(profilePath)).toBe(true);
  console.log(`Packaged application clean exit verified: ${cleanExitCode}`);
});

async function readFixturePreferences(page: Page) {
  return page.evaluate(() => {
    const root = JSON.parse(localStorage.getItem("persist:root") || "{}");
    const settings = JSON.parse(root.settings || "{}");
    const bookmarks = JSON.parse(root.bookmarks || "{}").bookmarks;
    // Return only the harmless fixture fields, never credentials or whole state.
    return {
      multipleOutputsEnabled: settings.multipleOutputsEnabled,
      bookmarks: bookmarks?.allIds.map((id: string) => ({
        url: bookmarks.byId[id].url as string,
        title: bookmarks.byId[id].title as string,
      })) ?? [],
    };
  });
}

async function readProbe(application: Awaited<ReturnType<typeof electron.launch>>) {
  return application.evaluate(() => {
    const surface = (
      globalThis as unknown as Record<
        string,
        { read: () => ProbeFacts } | undefined
      >
    )["__DUNGEON_JOCKEY_AUDIO_SMOKE_PROBE__"];
    if (!surface) throw new Error("main-process PCM probe is unavailable");
    return surface.read();
  });
}

function childProcessOutput(
  command: string,
  args: string[],
  extraEnvironment: NodeJS.ProcessEnv = {},
): string {
  const result = childProcess.spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, ...extraEnvironment },
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || "metadata check failed");
  return result.stdout;
}
