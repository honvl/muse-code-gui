import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  seedAgentDir,
} from "../helpers/electron-app";

test("a failed thread start keeps the prompt and shows the error", async () => {
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);
  const workspace = await makeWorkspace("new-thread-start-error");
  // An unborn Git repository cannot create a worktree, providing a real startup failure.
  execFileSync("git", ["init", workspace]);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspace],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await window
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    const prompt = window.getByLabel("New thread prompt", { exact: true });
    await prompt.fill("Keep this prompt when starting fails");
    await window.getByRole("button", { name: "Worktree", exact: true }).click();
    await window.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(window.getByTestId("composer-error-banner")).toBeVisible();
    await expect(prompt).toHaveValue("Keep this prompt when starting fails");
    await window.getByRole("button", { name: "Local", exact: true }).click();
    await window.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(window.getByTestId("composer")).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("opening New thread flushes the current conversation draft before navigation", async () => {
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("new-thread-draft")],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Original conversation");
    // Hold the ordinary debounce so the navigation flush, not elapsed time, must save the draft.
    await window.evaluate(() => {
      const schedule = globalThis.window.setTimeout.bind(globalThis.window);
      globalThis.window.setTimeout = (handler: TimerHandler, delay?: number, ...args: unknown[]) =>
        schedule(handler, delay === 350 ? 60_000 : delay, ...args);
    });
    const draft = "Keep this unsent draft in the original conversation";
    await window.getByTestId("composer").fill(draft);
    await window
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await expect(window.getByLabel("New thread prompt", { exact: true })).toBeVisible();
    await expect.poll(async () => (await getDesktopState(window)).composerDraft).toBe(draft);
    await createNamedThread(window, "Another conversation");
    await expect(window.getByTestId("composer")).toHaveValue("");
    await selectSession(window, "Original conversation");
    await expect(window.getByTestId("composer")).toHaveValue(draft);
  } finally {
    await harness.close();
  }
});
