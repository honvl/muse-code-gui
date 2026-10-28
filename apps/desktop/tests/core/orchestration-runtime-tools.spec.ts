import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  runOrchestrationRuntimeTool,
  seedAgentDir,
} from "../helpers/electron-app";

async function startHangingOpenAiServer(): Promise<{
  readonly baseUrl: string;
  readonly pendingRequestCount: () => number;
  readonly close: () => Promise<void>;
}> {
  const pending = new Set<import("node:http").ServerResponse>();
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((request, response) => {
    pending.add(response);
    response.on("close", () => pending.delete(response));
    request.resume();
    // Intentionally leave the response pending: create_child_thread must return
    // after the running acknowledgement rather than await this model turn.
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    pendingRequestCount: () => pending.size,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function selectedSessionRef(
  window: Parameters<typeof getDesktopState>[0],
): Promise<SessionRef> {
  const state = await getDesktopState(window);
  if (!state.selectedWorkspaceId || !state.selectedSessionId) {
    throw new Error("Expected a selected session");
  }
  return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
}

test("create_child_thread returns after a slow worker starts, before its turn completes", async () => {
  test.setTimeout(60_000);
  const proofDir = process.env.PI_APP_ORCHESTRATION_PROOF_DIR?.trim();
  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
  }
  const server = await startHangingOpenAiServer();
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("orchestration-runtime-start-ack");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["slow-test/slow"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: "slow-test",
        defaultModel: "slow",
        enabledModels: ["slow-test/slow"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          "slow-test": {
            baseUrl: server.baseUrl,
            api: "openai-completions",
            apiKey: "unused",
            models: [{ id: "slow" }],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Parent orchestration thread");
    const parentRef = await selectedSessionRef(window);
    const prompt = "Keep this delegated worker running slowly.";
    // The server never answers, so the child's first turn cannot complete. A tool
    // that awaited the turn would never return, and the test timeout names this step.
    const result = await test.step("create_child_thread returns while the turn is in flight", () =>
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "create-child-start-ack",
        sessionRef: parentRef,
        params: { prompt },
      }));

    expect(result.details).toMatchObject({ deliveryStatus: "running", prompt });
    // details.prompt round-trips the caller's raw prompt: the composed
    // child brief (with the always-on report suffix) is delivered to the
    // child but never echoed here.
    expect(String(result.details?.prompt)).not.toContain("Report back with:");
    // The worker's model request reached the server and is still unanswered.
    await expect.poll(() => server.pendingRequestCount()).toBeGreaterThan(0);
    const child = (await getDesktopState(window)).orchestrationChildren.find(
      (entry) => entry.sourceToolCallId === "create-child-start-ack",
    );
    expect(child?.status).toBe("running");
    // The child record keeps the raw goal for display; delivery used the brief.
    expect(child?.goal).toBe(prompt);
    // The group stays collapsed (children unmount), but the disclosure label
    // must still report the running child.
    const groupToggle = window.getByTestId("child-thread-group-toggle");
    await expect(groupToggle).toHaveAttribute("aria-expanded", "false");
    await expect(groupToggle).toContainText("1 running");
    await expect(
      window.locator(`.session-row[data-session-id="${child?.childSessionId}"]`),
    ).toHaveCount(0);
    if (proofDir) {
      await window.screenshot({
        path: join(proofDir, "orchestration-child-collapsed.png"),
        fullPage: true,
      });
    }
    await groupToggle.click();
    await expect(groupToggle).toHaveAttribute("aria-expanded", "true");
    const childRunningIndicator = window.locator(
      `.session-row[data-session-id="${child?.childSessionId}"] .session-row__status--running`,
    );
    await expect(childRunningIndicator).toBeVisible();
    if (proofDir) {
      await window.screenshot({
        path: join(proofDir, "orchestration-child-running.png"),
        fullPage: true,
      });
    }
  } finally {
    await harness.close();
    await server.close();
  }
});

test("create_child_thread surfaces deterministic initial-prompt delivery failures", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("orchestration-runtime-tools");
  await seedAgentDir(agentDir, { withOpenAiAuth: false });
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Parent orchestration thread");
    const parentRef = await selectedSessionRef(window);
    const prompt = "Child must start this delegated task.";

    await expect(
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "create-child-delivery-failure",
        sessionRef: parentRef,
        params: { prompt },
      }),
    ).rejects.toThrow(/API key|authentication|credential/i);

    const state = await getDesktopState(window);
    const matchingChildren = state.orchestrationChildren.filter(
      (entry) => entry.sourceToolCallId === "create-child-delivery-failure",
    );
    expect(matchingChildren).toHaveLength(1);
    expect(matchingChildren[0]?.status).toBe("failed");
    expect(matchingChildren[0]?.latestTranscript).toMatch(/API key|authentication|credential/i);
    expect(matchingChildren[0]?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Initial prompt delivery failed", status: "failed" }),
      ]),
    );

    // Replaying the same tool call must re-surface the failed launch, not treat
    // the already-created session record as proof of success or create a duplicate.
    await expect(
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "create-child-delivery-failure",
        sessionRef: parentRef,
        params: { prompt },
      }),
    ).rejects.toThrow(/API key|authentication|credential/i);
    expect(
      (await getDesktopState(window)).orchestrationChildren.filter(
        (entry) => entry.sourceToolCallId === "create-child-delivery-failure",
      ),
    ).toHaveLength(1);
  } finally {
    await harness.close();
  }
});

test("read_thread with wait_seconds returns immediately for an idle thread", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("orchestration-read-wait-idle");
  await seedAgentDir(agentDir, { withOpenAiAuth: false });
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Idle thread for waited read");
    const parentRef = await selectedSessionRef(window);
    const startedAt = Date.now();
    const result = await runOrchestrationRuntimeTool(harness, {
      toolName: "read_thread",
      toolCallId: "read-idle-with-wait",
      sessionRef: parentRef,
      params: { thread_id: parentRef.sessionId, wait_seconds: 30 },
    });
    // Idle means no wait: a 30s request must return in seconds, not after 30s.
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    expect(result.details).toMatchObject({ status: "idle" });
    expect(result.details?.timedOut).toBeUndefined();
    expect(result.details?.waitedSeconds).toBeUndefined();
  } finally {
    await harness.close();
  }
});

test("read_thread wait_seconds times out on a running thread with back-off guidance", async () => {
  test.setTimeout(90_000);
  const server = await startHangingOpenAiServer();
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("orchestration-read-wait-timeout");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["slow-test/slow"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: "slow-test",
        defaultModel: "slow",
        enabledModels: ["slow-test/slow"],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          "slow-test": {
            baseUrl: server.baseUrl,
            api: "openai-completions",
            apiKey: "unused",
            models: [{ id: "slow" }],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Parent for waited read timeout");
    const parentRef = await selectedSessionRef(window);
    await runOrchestrationRuntimeTool(harness, {
      toolName: "create_child_thread",
      toolCallId: "create-child-read-wait-timeout",
      sessionRef: parentRef,
      params: { prompt: "Stay running while the parent waits." },
    });
    const child = (await getDesktopState(window)).orchestrationChildren.find(
      (entry) => entry.sourceToolCallId === "create-child-read-wait-timeout",
    );
    expect(child?.status).toBe("running");
    const startedAt = Date.now();
    const result = await runOrchestrationRuntimeTool(harness, {
      toolName: "read_thread",
      toolCallId: "read-running-with-wait",
      sessionRef: parentRef,
      params: { thread_id: child?.childSessionId, wait_seconds: 2 },
    });
    const elapsedMs = Date.now() - startedAt;
    // Bounded wait: blocked ~2s for the hung child, then returned running.
    expect(elapsedMs).toBeGreaterThanOrEqual(1_500);
    expect(elapsedMs).toBeLessThan(30_000);
    expect(result.details).toMatchObject({ status: "running", timedOut: true });
    const text = result.content.map((entry) => entry.text ?? "").join("\n");
    expect(text).toMatch(/Still running after a 2s wait/);
    expect(text).toMatch(/wait_seconds/);
  } finally {
    await harness.close();
    await server.close();
  }
});
