import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  makeWorkspace,
  runOrchestrationRuntimeTool,
  seedAgentDir,
} from "../helpers/electron-app";

const execFileAsync = promisify(execFile);

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

/** OpenAI-completions SSE server that answers every request at once. */
async function startAnsweringOpenAiServer(): Promise<{
  readonly baseUrl: string;
  readonly prompts: string[];
  readonly close: () => Promise<void>;
}> {
  const prompts: string[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const payload = JSON.parse(body || "{}") as { model?: string; messages?: unknown };
      prompts.push(JSON.stringify(payload.messages ?? []));
      const base = { id: "chatcmpl-sidekick", object: "chat.completion.chunk", created: 0 };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const write = (choices: unknown[], extra: Record<string, unknown> = {}) =>
        response.write(
          `data: ${JSON.stringify({ ...base, model: payload.model, choices, ...extra })}\n\n`,
        );
      write([{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }]);
      write([{ index: 0, delta: {}, finish_reason: "stop" }], {
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      response.end("data: [DONE]\n\n");
    });
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
    prompts,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test("a lead's sequential worker briefs share one sidekick; parallel briefs do not", async () => {
  test.setTimeout(120_000);
  const server = await startAnsweringOpenAiServer();
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("orchestration-sidekick-reuse");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["answer-test/answer"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify({ defaultProvider: "answer-test", defaultModel: "answer", enabledModels: ["answer-test/answer"] }, null, 2)}\n`,
  );
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          "answer-test": {
            baseUrl: server.baseUrl,
            api: "openai-completions",
            apiKey: "unused",
            models: [{ id: "answer" }],
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
    await createNamedThread(window, "Lead with a sidekick");
    const parentRef = await selectedSessionRef(window);
    // Reuse is a Lead-mode behavior: switch the thread to Lead.
    await window.getByRole("button", { name: "Solo", exact: true }).click();
    await expect(window.getByRole("button", { name: "Lead", exact: true })).toBeVisible();
    const children = async () => (await getDesktopState(window)).orchestrationChildren;
    const statusOf = async (id: unknown) =>
      (await children()).find((entry) => entry.id === id)?.status;

    const first = await runOrchestrationRuntimeTool(harness, {
      toolName: "create_child_thread",
      toolCallId: "sidekick-brief-1",
      sessionRef: parentRef,
      params: { prompt: "Do SIDEKICK-ONE work.", scope: "apps/a" },
    });
    const sidekickId = first.details?.childThreadId;
    expect(first.details?.reused).toBeUndefined();
    await expect.poll(() => statusOf(sidekickId), { timeout: 30_000 }).toBe("complete");

    const second = await test.step("a sequential brief continues the idle sidekick", () =>
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "sidekick-brief-2",
        sessionRef: parentRef,
        params: { prompt: "Do SIDEKICK-TWO work.", scope: "apps/a" },
      }));
    expect(second.details).toMatchObject({
      reused: true,
      childThreadId: sidekickId,
      generation: 2,
    });
    expect(await children()).toHaveLength(1);
    // The second request carries the first brief: one session, one warm context.
    await expect
      .poll(
        () =>
          server.prompts.some(
            (prompt) => prompt.includes("SIDEKICK-ONE") && prompt.includes("SIDEKICK-TWO"),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await expect.poll(() => statusOf(sidekickId), { timeout: 30_000 }).toBe("complete");

    const parallel = await test.step("parallel briefs produce separate children", () =>
      Promise.all(
        ["apps/b", "apps/c"].map((scope, index) =>
          runOrchestrationRuntimeTool(harness, {
            toolName: "create_child_thread",
            toolCallId: `sidekick-parallel-${index}`,
            sessionRef: parentRef,
            params: { prompt: `Parallel slice ${scope}.`, scope },
          }),
        ),
      ));
    const ids = parallel.map((result) => result.details?.childThreadId);
    expect(parallel.map((result) => result.details?.error)).toEqual([undefined, undefined]);
    expect(new Set(ids).size).toBe(2);
    expect(parallel.filter((result) => result.details?.reused === true)).toHaveLength(1);
    expect(await children()).toHaveLength(2);
  } finally {
    await harness.close();
    await server.close();
  }
});

test("two worktree workers with overlapping scopes run concurrently, each on its own branch", async () => {
  test.setTimeout(120_000);
  const server = await startAnsweringOpenAiServer();
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeGitWorkspace("orchestration-worktree-children");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["answer-test/answer"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify({ defaultProvider: "answer-test", defaultModel: "answer", enabledModels: ["answer-test/answer"] }, null, 2)}\n`,
  );
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          "answer-test": {
            baseUrl: server.baseUrl,
            api: "openai-completions",
            apiKey: "unused",
            models: [{ id: "answer" }],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const launch = () =>
    launchDesktop(userDataDir, {
      agentDir,
      initialWorkspaces: [workspacePath],
      scrubProviderEnv: true,
      testMode: "background",
    });
  let harness = await launch();

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Lead with worktree workers");
    const parentRef = await selectedSessionRef(window);
    // Reports reach Lead parents only: switch the thread to Lead.
    await window.getByRole("button", { name: "Solo", exact: true }).click();
    await expect(window.getByRole("button", { name: "Lead", exact: true })).toBeVisible();

    // Both claim apps/a: in the shared checkout the second would be refused.
    const results = await Promise.all(
      [1, 2].map((n) =>
        runOrchestrationRuntimeTool(harness, {
          toolName: "create_child_thread",
          toolCallId: `worktree-worker-${n}`,
          sessionRef: parentRef,
          params: { prompt: `Worktree slice ${n}.`, scope: "apps/a", isolation: "worktree" },
        }),
      ),
    );
    expect(results.map((result) => result.details?.error)).toEqual([undefined, undefined]);
    const ids = results.map((result) => String(result.details?.childThreadId));
    expect(new Set(ids).size).toBe(2);

    const state = await getDesktopState(window);
    const children = ids.map((id) => state.orchestrationChildren.find((entry) => entry.id === id)!);
    for (const child of children) {
      const short = child.id.slice(0, 8);
      expect(child.branch).toBe(`child/${short}`);
      expect(child.worktreePath).toBe(join(workspacePath, ".worktrees", short));
      expect(child.writeScopes).toBeUndefined();
      // The checkout nests under the folder instead of becoming its own folder.
      const workspace = state.workspaces.find((entry) => entry.id === child.childWorkspaceId);
      expect(workspace?.path).toBe(child.worktreePath);
      expect(workspace?.kind).toBe("worktree");
      expect(workspace?.rootWorkspaceId).toBe(parentRef.workspaceId);
    }

    // Each run ends and its report, naming its branch, reaches the lead.
    await expect
      .poll(
        async () =>
          (await getDesktopState(window)).orchestrationChildren
            .filter((entry) => ids.includes(entry.id))
            .map((entry) => entry.status),
        { timeout: 60_000 },
      )
      .toEqual(["complete", "complete"]);
    for (const child of children) {
      await expect
        .poll(() => server.prompts.some((prompt) => prompt.includes(`branch: ${child.branch} (`)), {
          timeout: 60_000,
        })
        .toBe(true);
    }

    // Both children appear under the lead in the sidebar.
    const groupToggle = window.getByTestId("child-thread-group-toggle");
    if ((await groupToggle.getAttribute("aria-expanded")) === "false") {
      await groupToggle.click();
    }
    for (const child of children) {
      await expect(
        window.locator(`.session-row[data-session-id="${child.childSessionId}"]`),
      ).toBeVisible();
    }

    // Excluded through info/exclude; the main checkout stays clean.
    const exclude = await readFile(join(workspacePath, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.worktrees/");
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: workspacePath,
    });
    expect(stdout.trim()).toBe("");

    // After a restart the children keep their status and record, and a
    // follow-up continues the same session in its worktree.
    await harness.close();
    harness = await launch();
    const restartedWindow = await harness.firstWindow();
    await expect
      .poll(async () => {
        const restored = (await getDesktopState(restartedWindow)).orchestrationChildren;
        return ids.map((id) => {
          const entry = restored.find((candidate) => candidate.id === id);
          return [entry?.status, entry?.branch, entry?.worktreePath];
        });
      })
      .toEqual(children.map((child) => ["complete", child.branch, child.worktreePath]));
    const followUp = await runOrchestrationRuntimeTool(harness, {
      toolName: "send_message_to_thread",
      toolCallId: "worktree-follow-up",
      sessionRef: parentRef,
      params: { thread_id: ids[0], message: "WORKTREE-FOLLOW-UP" },
    });
    expect(followUp.details?.error).toBeUndefined();
    await expect
      .poll(
        () =>
          server.prompts.some(
            (prompt) =>
              prompt.includes("WORKTREE-FOLLOW-UP") &&
              prompt.includes("Worktree slice 1.") &&
              prompt.includes(children[0]!.worktreePath!),
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await getDesktopState(restartedWindow)).orchestrationChildren.find(
            (entry) => entry.id === ids[0],
          )?.status,
        { timeout: 60_000 },
      )
      .toBe("complete");
  } finally {
    await harness.close();
    await server.close();
  }
});
