import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSession,
} from "../helpers/electron-app";

async function selectedSessionRef(
  window: Parameters<typeof getDesktopState>[0],
): Promise<SessionRef> {
  const state = await getDesktopState(window);
  if (!state.selectedWorkspaceId || !state.selectedSessionId) {
    throw new Error("Expected a selected session");
  }
  return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
}

async function selectedSessionSidekick(
  window: Parameters<typeof getDesktopState>[0],
  ref: SessionRef,
): Promise<{ provider: string; modelId: string } | undefined> {
  const state = await getDesktopState(window);
  const session = state.workspaces
    .flatMap((workspace) => workspace.sessions)
    .find((entry) => entry.id === ref.sessionId);
  return session?.config?.sidekick;
}

test("lead-mode sidekick picker drives config.sidekick from badge to reset", async () => {
  test.setTimeout(90_000);
  const proofDir = process.env.PI_APP_LEAD_MODE_PROOF_DIR?.trim();
  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
  }
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("sidekick-picker");
  // Default seed enables two models (openai/gpt-5 default, openai/gpt-4o spare);
  // the spec picks the non-default one without inventing catalog entries.
  await seedAgentDir(agentDir);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Lead thread with sidekick");
    const leadRef = await selectedSessionRef(window);

    // The badge only exists in lead mode.
    await expect(window.getByRole("button", { name: /^Sidekick:/ })).toHaveCount(0);

    await window.getByRole("button", { name: "Orchestrate", exact: true }).click();
    await expect(window.getByRole("button", { name: "Orchestrator", exact: true })).toBeVisible();
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        const session = state.workspaces
          .flatMap((workspace) => workspace.sessions)
          .find((entry) => entry.id === leadRef.sessionId);
        return session?.config?.orchestratorMode === true;
      })
      .toBe(true);

    const sidekickBadge = window.getByRole("button", { name: /^Sidekick:/ });
    await expect(sidekickBadge).toBeVisible();
    await expect(sidekickBadge).toHaveText("Sidekick: workspace default");
    await expect.poll(() => selectedSessionSidekick(window, leadRef)).toBeUndefined();

    // Open the picker, capture the model list, then pick the non-default model.
    await sidekickBadge.click();
    const dropdown = window.locator(".model-selector__dropdown");
    await expect(dropdown.getByRole("button", { name: "Workspace default" })).toBeVisible();
    await expect(dropdown.getByRole("button", { name: "GPT-4o" })).toBeVisible();
    if (proofDir) {
      await window.screenshot({
        path: join(proofDir, "sidekick-picker-open.png"),
        fullPage: true,
      });
    }
    await dropdown.getByRole("button", { name: "GPT-4o" }).click();

    await expect
      .poll(() => selectedSessionSidekick(window, leadRef))
      .toEqual({ provider: "openai", modelId: "gpt-4o" });
    await expect(sidekickBadge).toContainText("GPT-4o");

    // Reselecting the thread keeps the chosen sidekick.
    await createNamedThread(window, "Unrelated second thread");
    await selectSession(window, "Lead thread with sidekick");
    await expect
      .poll(() => selectedSessionSidekick(window, leadRef))
      .toEqual({ provider: "openai", modelId: "gpt-4o" });
    await expect(window.getByRole("button", { name: /^Sidekick:/ })).toContainText("GPT-4o");

    // Resetting to the workspace default clears the selection and the badge.
    await window.getByRole("button", { name: /^Sidekick:/ }).click();
    await window
      .locator(".model-selector__dropdown")
      .getByRole("button", { name: "Workspace default" })
      .click();
    await expect.poll(() => selectedSessionSidekick(window, leadRef)).toBeUndefined();
    await expect(window.getByRole("button", { name: /^Sidekick:/ })).toHaveText(
      "Sidekick: workspace default",
    );
  } finally {
    await harness.close();
  }
});
