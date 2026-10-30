import assert from "node:assert/strict";
import test from "node:test";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import { RESCUE_ABORT_TIMEOUT_MS, SessionSupervisor } from "../dist/session-supervisor.js";

function makeCatalog() {
  const writes: unknown[] = [];
  return {
    writes,
    sessions: {
      upsertSession: async (entry: unknown) => {
        writes.push(entry);
      },
      getSession: async () => {
        throw new Error("must not reopen for an active record");
      },
    },
    workspaces: {
      getWorkspace: async () => {
        throw new Error("must not reopen for an active record");
      },
    },
    setSessionFile: async () => undefined,
  };
}

interface FakeSessionOptions {
  /** Never-resolving abort simulates a tool whose promise ignores the signal. */
  readonly abortBehavior: "settle" | "hang" | "throw";
}

function makeSession(options: FakeSessionOptions) {
  let streaming = true;
  let abortBashCalls = 0;
  let clearQueueCalls = 0;
  const session = {
    get isStreaming() {
      return streaming;
    },
    setStreaming(value: boolean) {
      streaming = value;
    },
    abortCalls: 0,
    abortBashCalls: () => abortBashCalls,
    clearQueueCalls: () => clearQueueCalls,
    abort: async () => {
      session.abortCalls += 1;
      if (options.abortBehavior === "throw") {
        throw new Error("abort exploded");
      }
      if (options.abortBehavior === "settle") {
        streaming = false;
        return;
      }
      await new Promise<void>(() => {});
    },
    abortBash: () => {
      abortBashCalls += 1;
    },
    clearQueue: () => {
      clearQueueCalls += 1;
    },
    extensionRunner: { getRegisteredCommands: () => [] },
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
  };
  return session;
}

function makeRecord(session: ReturnType<typeof makeSession>) {
  return {
    ref: { workspaceId: "ws-1", sessionId: "sess-1" },
    workspace: { workspaceId: "ws-1", path: "/tmp/ws-1", displayName: "ws-1" },
    title: "rescue probe",
    status: "running",
    updatedAt: new Date().toISOString(),
    archivedAt: undefined,
    preview: undefined,
    config: undefined,
    runningRunId: "run-1",
    cancellationRequested: false,
    promptStarting: false,
    abortOnRunStart: false,
    queuedMessages: [],
    closed: false,
    reloading: undefined,
    reloadPending: false,
    inFlightToolCalls: new Map([["call-bash", "bash"]]),
    piQueueSync: Promise.resolve(),
    eventQueue: Promise.resolve(),
    session,
    listeners: new Set<(event: SessionDriverEvent) => void>(),
  };
}

function mountSupervisor(record: ReturnType<typeof makeRecord>) {
  const catalog = makeCatalog();
  const supervisor = new SessionSupervisor({
    catalogStorage: catalog as never,
  });
  const key = `${record.ref.workspaceId}:${record.ref.sessionId}`;
  (supervisor as unknown as { records: Map<string, unknown> }).records.set(key, record);
  const emitted: SessionDriverEvent[] = [];
  record.listeners.add((event) => {
    emitted.push(event);
  });
  return { supervisor, catalog, emitted };
}

await test("rescue settles a cooperative abort without forcing", async () => {
  const session = makeSession({ abortBehavior: "settle" });
  const record = makeRecord(session);
  const { supervisor, emitted } = mountSupervisor(record);

  const result = await supervisor.rescueCurrentRun(record.ref, { abortTimeoutMs: 50 });

  assert.deepEqual(result, { forced: false });
  assert.equal(session.abortCalls, 1);
  assert.equal(session.abortBashCalls(), 0, "cooperative abort needs no bash kill");
  assert.equal(record.status, "idle");
  assert.equal(record.runningRunId, undefined);
  assert.equal(record.cancellationRequested, true);
  assert.ok(
    emitted.some((event) => event.type === "sessionUpdated"),
    "rescue publishes the idle state",
  );
  assert.ok(
    emitted.every((event) => event.type !== "toolFinished"),
    "no synthetic tool finish when the abort settles on its own",
  );
  assert.deepEqual(
    [...record.inFlightToolCalls.keys()],
    ["call-bash"],
    "the real tool end still to come clears the entry",
  );
});

await test("rescue force-stops a run whose abort never settles", async () => {
  const session = makeSession({ abortBehavior: "hang" });
  const record = makeRecord(session);
  const { supervisor, emitted } = mountSupervisor(record);

  const result = await supervisor.rescueCurrentRun(record.ref, { abortTimeoutMs: 20 });

  assert.deepEqual(result, { forced: true });
  assert.equal(session.abortCalls, 1);
  assert.equal(session.abortBashCalls(), 1, "force path kills tracked interactive bash");
  assert.equal(record.status, "idle", "the host reads idle even though pi is wedged");
  assert.equal(record.runningRunId, undefined);
  assert.equal(record.cancellationRequested, true);
  assert.equal(record.inFlightToolCalls.size, 0, "stuck entries are consumed by the marking");
  const finished = emitted.filter((event) => event.type === "toolFinished");
  assert.equal(finished.length, 1, "the stuck tool is marked exactly once");
  assert.equal(finished[0]?.type, "toolFinished");
  if (finished[0]?.type === "toolFinished") {
    assert.equal(finished[0].callId, "call-bash");
    assert.equal(finished[0].success, false);
    assert.match(
      JSON.stringify(finished[0].output ?? ""),
      /Rescued by the lead/,
      "the row carries the rescue note",
    );
  }
});

await test("rescue treats a failing abort as settled once the run stops streaming", async () => {
  const session = makeSession({ abortBehavior: "throw" });
  const record = makeRecord(session);
  const { supervisor } = mountSupervisor(record);
  session.setStreaming(false);

  const result = await supervisor.rescueCurrentRun(record.ref, { abortTimeoutMs: 20 });

  assert.deepEqual(result, { forced: false });
  assert.equal(record.status, "idle");
});

await test("rescue without a live session is a no-op", async () => {
  const catalog = makeCatalog();
  const supervisor = new SessionSupervisor({
    catalogStorage: catalog as never,
  });
  const result = await supervisor.rescueCurrentRun({ workspaceId: "ws-1", sessionId: "missing" });
  assert.deepEqual(result, { forced: false });
  assert.deepEqual(catalog.writes, []);
});

await test("cancelCurrentRun still resets local state after a settling abort", async () => {
  const session = makeSession({ abortBehavior: "settle" });
  const record = makeRecord(session);
  const { supervisor, emitted } = mountSupervisor(record);

  await supervisor.cancelCurrentRun(record.ref);

  assert.equal(record.status, "idle");
  assert.equal(record.runningRunId, undefined);
  assert.ok(emitted.some((event) => event.type === "sessionUpdated"));
  assert.ok(emitted.every((event) => event.type !== "toolFinished"));
});

await test("tool start/end events maintain the in-flight set rescue reads", () => {
  const session = makeSession({ abortBehavior: "settle" });
  const record = makeRecord(session);
  record.inFlightToolCalls.clear();
  const { supervisor } = mountSupervisor(record);
  const inner = supervisor as unknown as {
    mapAgentEvent(input: typeof record, event: unknown): SessionDriverEvent[];
  };

  inner.mapAgentEvent(record, {
    type: "tool_execution_start",
    toolName: "bash",
    toolCallId: "call-1",
    args: { command: "sleep 60" },
  });
  inner.mapAgentEvent(record, {
    type: "tool_execution_start",
    toolName: "read",
    toolCallId: "call-2",
    args: { path: "a.ts" },
  });
  assert.deepEqual(
    [...record.inFlightToolCalls.entries()],
    [
      ["call-1", "bash"],
      ["call-2", "read"],
    ],
  );
  inner.mapAgentEvent(record, {
    type: "tool_execution_end",
    toolCallId: "call-1",
    result: { content: [{ type: "text", text: "done" }] },
    isError: false,
  });
  assert.deepEqual([...record.inFlightToolCalls.entries()], [["call-2", "read"]]);
  inner.mapAgentEvent(record, { type: "agent_settled" });
  assert.equal(record.inFlightToolCalls.size, 0, "settle clears leftovers");
});

await test("rescue abort timeout defaults to five seconds", () => {
  assert.equal(RESCUE_ABORT_TIMEOUT_MS, 5_000);
});
