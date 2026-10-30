import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, type DesktopHarness } from "../helpers/electron-app";

const VALID_TEST_MODES = ["background", "foreground"] as const;
const NORMAL_LIFECYCLE_CASES = [
  { label: "unset", value: undefined },
  { label: "empty", value: "" },
  { label: "invalid", value: "unsupported" },
] as const;

async function launchLifecycleApp(testMode: string | undefined): Promise<DesktopHarness> {
  const userDataDir = await makeUserDataDir("pi-gui-lifecycle-");
  const harness = await launchDesktop(userDataDir, {
    envOverrides: { PI_APP_TEST_MODE: testMode },
  });
  await harness.firstWindow();
  return harness;
}

async function closeLastWindow(harness: DesktopHarness): Promise<void> {
  await harness.electronApp.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length !== 1) {
      throw new Error(`Expected one app window before close, received ${windows.length}.`);
    }
    windows[0]?.close();
  });
}

async function quitDesktop(harness: DesktopHarness): Promise<void> {
  const closed = harness.electronApp.waitForEvent("close");
  await harness.electronApp.evaluate(({ app }) => app.quit());
  await closed;
}

test.describe("macOS last-window lifecycle", () => {
  test.skip(
    process.platform !== "darwin",
    "macOS keeps a normal app alive after its last window closes.",
  );

  for (const mode of VALID_TEST_MODES) {
    test(`quits after the last window closes in ${mode} test mode`, async () => {
      test.setTimeout(30_000);
      const harness = await launchLifecycleApp(mode);
      let appClosed = false;
      harness.electronApp.on("close", () => {
        appClosed = true;
      });

      try {
        const closed = harness.electronApp.waitForEvent("close");
        await closeLastWindow(harness);
        await closed;
      } finally {
        if (!appClosed) {
          await quitDesktop(harness);
        }
      }
    });
  }

  // 9cd69705: with no running thread, background task or active scheduled task,
  // an idle app quits with its last window instead of lingering in the dock. The
  // keep-alive-while-working decision is covered by tests/unit/app-lifecycle.spec.ts.
  for (const { label, value } of NORMAL_LIFECYCLE_CASES) {
    test(`quits after the last window closes when idle and PI_APP_TEST_MODE is ${label}`, async () => {
      test.setTimeout(30_000);
      const harness = await launchLifecycleApp(value);
      let appClosed = false;
      harness.electronApp.on("close", () => {
        appClosed = true;
      });

      try {
        const closed = harness.electronApp.waitForEvent("close");
        await closeLastWindow(harness);
        await closed;
      } finally {
        if (!appClosed) {
          await quitDesktop(harness);
        }
      }
    });
  }
});
