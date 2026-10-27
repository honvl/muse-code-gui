import { expect, test } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
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

async function seedUserMessage(
  harness: Awaited<ReturnType<typeof launchDesktop>>,
  sessionRef: SessionRef,
  id: string,
  text: string,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const event: Extract<SessionDriverEvent, { type: "queuedMessageStarted" }> = {
    type: "queuedMessageStarted",
    sessionRef,
    timestamp,
    message: { id, mode: "followUp", text, createdAt: timestamp, updatedAt: timestamp },
  };
  await emitTestSessionEvent(harness, event);
}

test("shows a read receipt on a user message once the agent produces work", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("message-read-receipt-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Read receipt proof");

    const sessionRef = await selectedSessionRef(window);
    await seedUserMessage(harness, sessionRef, "read-receipt-user-row", "Read receipt prompt");

    const userRow = window.locator(".timeline-item--user", { hasText: "Read receipt prompt" });
    await expect(userRow).toBeVisible({ timeout: 15_000 });
    // The prompt is still waiting for its turn: no checkmark yet.
    await expect(userRow.getByTestId("message-read-receipt")).toHaveCount(0);

    const timestamp = new Date().toISOString();
    await emitTestSessionEvent(harness, {
      type: "toolStarted",
      sessionRef,
      timestamp,
      toolName: "read",
      callId: "read-receipt-tool-call",
      input: { file_path: "/tmp/read-receipt-proof.txt" },
    } satisfies Extract<SessionDriverEvent, { type: "toolStarted" }>);

    // The agent picked the prompt up: a quiet check appears in the bubble's lower right.
    await expect(userRow.getByTestId("message-read-receipt")).toBeVisible({ timeout: 15_000 });

    // A second prompt with no downstream work stays unread while the first stays read.
    await seedUserMessage(harness, sessionRef, "read-receipt-user-row-2", "Second prompt");
    const secondRow = window.locator(".timeline-item--user", { hasText: "Second prompt" });
    await expect(secondRow).toBeVisible({ timeout: 15_000 });
    await expect(secondRow.getByTestId("message-read-receipt")).toHaveCount(0);
    await expect(userRow.getByTestId("message-read-receipt")).toBeVisible();
  } finally {
    await harness.close();
  }
});
