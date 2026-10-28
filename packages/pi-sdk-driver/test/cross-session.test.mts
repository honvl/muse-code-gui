import assert from "node:assert/strict";
import test from "node:test";
import { SessionSupervisor } from "../dist/session-supervisor.js";
import {
  createCrossSessionRuntimeExtension,
  createCrossSessionRuntimeTools,
  formatTranscriptExcerpt,
  listThreadsToolName,
  messageThreadToolName,
  readThreadToolName,
  type CrossSessionBridge,
} from "../dist/cross-session.js";

function makeBridge(overrides: Partial<CrossSessionBridge> = {}): CrossSessionBridge & {
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    listThreads: async () => {
      calls.push({ method: "listThreads", args: [] });
      return [];
    },
    readThread: async (sessionId: string) => {
      calls.push({ method: "readThread", args: [sessionId] });
      return {
        sessionId,
        title: "Other",
        status: "idle",
        excerpt: "user: hello",
        truncated: false,
      };
    },
    deliverMessage: async (source, targetSessionId: string, text: string) => {
      calls.push({ method: "deliverMessage", args: [source, targetSessionId, text] });
      return { targetSessionId, targetTitle: "Other", mode: "turn" as const };
    },
    ...overrides,
  };
}

const fakeCtx = { sessionManager: { getSessionId: () => "src-1" } } as never;

function tool(bridge: CrossSessionBridge, name: string) {
  const found = createCrossSessionRuntimeTools(bridge, () => ({
    workspaceId: "ws",
    sessionId: "src-1",
  })).find((entry) => entry.name === name);
  assert.ok(found, `tool ${name} registered`);
  return found!;
}

await test("list_threads formats threads with status and count", async () => {
  const bridge = makeBridge({
    listThreads: async () => [
      {
        sessionId: "a",
        workspaceId: "ws",
        workspaceName: "demo",
        title: "Alpha",
        status: "idle",
        updatedAt: "2026-10-27T18:00:00.000Z",
        preview: "did the thing",
      },
      {
        sessionId: "b",
        workspaceId: "ws",
        title: "Bravo",
        status: "running",
        updatedAt: "2026-10-27T19:00:00.000Z",
      },
    ],
  });
  const result = await tool(bridge, listThreadsToolName).execute(
    "call-1",
    {},
    undefined,
    undefined,
    fakeCtx,
  );
  const text = (result.content[0] as { text: string }).text;
  assert.match(text, /Alpha/);
  assert.match(text, /running/);
  assert.equal((result.details as { count?: number }).count, 2);
});

await test("list_threads reports when no threads are open", async () => {
  const bridge = makeBridge();
  const result = await tool(bridge, listThreadsToolName).execute(
    "call-1",
    {},
    undefined,
    undefined,
    fakeCtx,
  );
  assert.equal((result.details as { count?: number }).count, 0);
});

await test("read_thread requires a session id and formats the excerpt", async () => {
  const bridge = makeBridge();
  const missing = await tool(bridge, readThreadToolName).execute(
    "call-1",
    {},
    undefined,
    undefined,
    fakeCtx,
  );
  assert.match((missing.details as { error?: string }).error ?? "", /session_id/);

  const ok = await tool(bridge, readThreadToolName).execute(
    "call-2",
    { session_id: "a" },
    undefined,
    undefined,
    fakeCtx,
  );
  assert.equal((ok.details as { sessionId?: string }).sessionId, "a");
  assert.match((ok.content[1] as { text: string }).text, /hello/);
});

await test("message_thread validates input before delivering", async () => {
  const bridge = makeBridge();
  const noTarget = await tool(bridge, messageThreadToolName).execute(
    "call-1",
    { text: "hi" },
    undefined,
    undefined,
    fakeCtx,
  );
  assert.match((noTarget.details as { error?: string }).error ?? "", /session_id/);

  const noText = await tool(bridge, messageThreadToolName).execute(
    "call-2",
    { session_id: "a" },
    undefined,
    undefined,
    fakeCtx,
  );
  assert.match((noText.details as { error?: string }).error ?? "", /non-empty text/);

  const tooLong = await tool(bridge, messageThreadToolName).execute(
    "call-3",
    { session_id: "a", text: "x".repeat(8001) },
    undefined,
    undefined,
    fakeCtx,
  );
  assert.match((tooLong.details as { error?: string }).error ?? "", /under 8000/);
  assert.equal(bridge.calls.filter((call) => call.method === "deliverMessage").length, 0);
});

await test("message_thread delivers and reports held follow-ups", async () => {
  const bridge = makeBridge();
  const baseDeliver = bridge.deliverMessage;
  bridge.deliverMessage = (async (source, targetSessionId: string) => {
    await baseDeliver(source, targetSessionId, "the schema changed");
    return {
      targetSessionId,
      targetTitle: "Bravo",
      mode: "queued" as const,
    };
  }) as typeof bridge.deliverMessage;
  const result = await tool(bridge, messageThreadToolName).execute(
    "call-1",
    { session_id: "b", text: "the schema changed" },
    undefined,
    undefined,
    fakeCtx,
  );
  assert.equal((result.details as { mode?: string }).mode, "queued");
  assert.match((result.content[0] as { text: string }).text, /held/);
  const delivery = bridge.calls.find((call) => call.method === "deliverMessage");
  assert.deepEqual(delivery?.args[0], { workspaceId: "ws", sessionId: "src-1" });
  assert.equal(delivery?.args[1], "b");
});

await test("message_thread surfaces delivery failures", async () => {
  const bridge = makeBridge({
    deliverMessage: async () => {
      throw new Error("Unknown thread: nope. Use list_threads to find an open thread.");
    },
  });
  const result = await tool(bridge, messageThreadToolName).execute(
    "call-1",
    { session_id: "nope", text: "hi" },
    undefined,
    undefined,
    fakeCtx,
  );
  assert.match((result.details as { error?: string }).error ?? "", /Unknown thread/);
});

await test("formatTranscriptExcerpt caps items and characters", () => {
  const many = Array.from({ length: 100 }, (_, index) => ({
    role: "user",
    text: `message ${index}`,
  }));
  const capped = formatTranscriptExcerpt(many);
  assert.ok(capped.truncated);
  assert.ok(!capped.excerpt.includes("message 0"));

  const long = [{ role: "assistant", text: "y".repeat(20_000) }];
  const cut = formatTranscriptExcerpt(long);
  assert.ok(cut.truncated);
  assert.ok(cut.excerpt.length < 20_000);

  const withTool = [
    { role: "user", text: "run it" },
    { role: "assistant", text: "", toolName: "bash" },
  ];
  const rendered = formatTranscriptExcerpt(withTool);
  assert.ok(!rendered.truncated);
  assert.match(rendered.excerpt, /\[tool bash\]/);
});

await test("createCrossSessionRuntimeTools omits superseded tools", () => {
  const bridge = makeBridge();
  const all = createCrossSessionRuntimeTools(bridge).map((entry) => entry.name).sort();
  assert.deepEqual(all, [listThreadsToolName, messageThreadToolName, readThreadToolName]);

  const omitted = createCrossSessionRuntimeTools(bridge, undefined, [
    listThreadsToolName,
    messageThreadToolName,
  ])
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(omitted, [readThreadToolName]);
});

await test("createCrossSessionRuntimeExtension registers only non-superseded tools", () => {
  const bridge = makeBridge();
  const run = (factory: (pi: never) => unknown) => {
    const registered: string[] = [];
    factory({ registerTool: (tool: { name: string }) => void registered.push(tool.name) } as never);
    return registered.sort();
  };
  // Orchestration enabled: it supersedes the whole trio, so cross-session adds nothing.
  assert.deepEqual(
    run(
      createCrossSessionRuntimeExtension(bridge, undefined, [
        listThreadsToolName,
        readThreadToolName,
        messageThreadToolName,
      ]),
    ),
    [],
  );
  // Orchestration disabled: nothing superseded, the trio registers as today.
  assert.deepEqual(run(createCrossSessionRuntimeExtension(bridge)), [
    listThreadsToolName,
    messageThreadToolName,
    readThreadToolName,
  ]);
});

await test("createCrossSessionRuntimeExtension re-evaluates the omit list on every load", () => {
  const bridge = makeBridge();
  let enabled = true;
  const factory = createCrossSessionRuntimeExtension(bridge, undefined, () =>
    enabled ? [messageThreadToolName] : [],
  );
  const run = () => {
    const registered: string[] = [];
    factory({ registerTool: (tool: { name: string }) => void registered.push(tool.name) } as never);
    return registered.sort();
  };
  assert.deepEqual(run(), [listThreadsToolName, readThreadToolName]);
  enabled = false;
  assert.deepEqual(run(), [listThreadsToolName, messageThreadToolName, readThreadToolName]);
});

function makeCatalog() {
  const workspaces = [
    {
      workspaceId: "ws",
      path: "/tmp/ws",
      displayName: "demo",
      lastOpenedAt: "2026-10-27T18:00:00.000Z",
      sortOrder: 0,
    },
  ];
  const sessions = [
    {
      sessionRef: { workspaceId: "ws", sessionId: "idle-1" },
      workspaceId: "ws",
      title: "Idle Thread",
      updatedAt: "2026-10-27T18:00:00.000Z",
      archivedAt: undefined,
      previewSnippet: "did the thing",
      status: "idle" as const,
    },
    {
      sessionRef: { workspaceId: "ws", sessionId: "old-1" },
      workspaceId: "ws",
      title: "Old Thread",
      updatedAt: "2026-10-27T17:00:00.000Z",
      archivedAt: "2026-10-27T17:30:00.000Z",
      status: "idle" as const,
    },
  ];
  return {
    workspaces: {
      listWorkspaces: async () => ({ workspaces }),
    },
    sessions: {
      listSessions: async () => ({ sessions }),
      getSession: async () => undefined,
    },
  };
}

function makeSupervisor() {
  return new SessionSupervisor({ catalogStorage: makeCatalog() as never });
}

await test("listCrossSessionThreads excludes archived threads", async () => {
  const supervisor = makeSupervisor();
  const threads = await supervisor.listCrossSessionThreads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0]?.sessionId, "idle-1");
  assert.equal(threads[0]?.workspaceName, "demo");
});

await test("deliverCrossSessionMessage rejects unknown, archived, and self targets", async () => {
  const supervisor = makeSupervisor();
  const source = { workspaceId: "ws", sessionId: "src-1" };
  await assert.rejects(
    supervisor.deliverCrossSessionMessage(source, "missing", "hi"),
    /Unknown thread/,
  );
  await assert.rejects(supervisor.deliverCrossSessionMessage(source, "old-1", "hi"), /archived/);
  await assert.rejects(
    supervisor.deliverCrossSessionMessage(
      { workspaceId: "ws", sessionId: "idle-1" },
      "idle-1",
      "hi",
    ),
    /already in this thread/,
  );
});
