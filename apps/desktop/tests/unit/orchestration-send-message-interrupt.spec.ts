import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  createOrchestrationRuntimeTools,
  sendMessageToThreadToolName,
} from "../../electron/orchestration/orchestration-runtime";
import { createOrchestrationOwner } from "../../electron/orchestration/app-store-orchestration";

const parentRef: SessionRef = { workspaceId: "ws", sessionId: "parent" };
const childRef: SessionRef = { workspaceId: "ws", sessionId: "child" };

interface HostState {
  status: "running" | "idle";
  cancelBehavior: "resolve" | "reject";
}

function makeHost(state: HostState) {
  const cancels: SessionRef[] = [];
  const submits: Array<{
    sessionRef: SessionRef;
    text: string;
    deliverAs: "steer" | "followUp" | undefined;
  }> = [];
  const host = {
    driver: {
      cancelCurrentRun: async (sessionRef: SessionRef) => {
        cancels.push(sessionRef);
        if (state.cancelBehavior === "reject") {
          throw new Error("already settled");
        }
      },
      createSession: async () => {
        throw new Error("not used");
      },
      setChildIsolation: () => {},
      sendCustomMessage: async () => {},
    },
    initialize: async () => {},
    orchestrationState: () => ({
      selectedWorkspaceId: "ws",
      selectedSessionId: "parent",
      workspaces: [
        {
          id: "ws",
          sessions: [
            {
              id: "parent",
              title: "Parent",
              status: "running",
              updatedAt: "2026-10-28T00:00:00.000Z",
              preview: "",
            },
            {
              id: "child",
              title: "Child",
              status: state.status,
              updatedAt: "2026-10-28T00:00:00.000Z",
              preview: "",
            },
          ],
        },
      ],
      orchestrationChildren: [],
    }),
    replaceOrchestrationChildren: () => {},
    refreshState: async () => ({}) as never,
    emit: () => ({}) as never,
    withError: async () => ({}) as never,
    persistUiState: async () => {},
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/tmp/ws" }),
    sessionFromState: (ref: SessionRef) =>
      ref.sessionId === childRef.sessionId
        ? { status: state.status, title: "Child", updatedAt: "2026-10-28T00:00:00.000Z" }
        : ref.sessionId === parentRef.sessionId
          ? { status: "running", title: "Parent", updatedAt: "2026-10-28T00:00:00.000Z" }
          : undefined,
    ensureSessionReady: async () => undefined,
    ensureSessionSubscription: async () => {},
    subscribeToSessionEvents: () => () => {},
    updateSessionConfig: () => {},
    isOrchestratorSession: () => true,
    sidekickModelFor: () => undefined,
    sessionModelFor: () => undefined,
    buildCreateSessionOptions: async () => undefined,
    getQueuedComposerMessages: () => [],
    seedSession: () => {},
    transcriptFor: () => [],
    transcriptForKey: () => [],
    replaceTranscript: () => {},
    isTranscriptLoaded: () => true,
    getSessionError: () => undefined,
    setSessionError: () => {},
    submitComposerToSession: async (
      sessionRef: SessionRef,
      text: string,
      _attachments: readonly never[],
      options?: { readonly deliverAs?: "steer" | "followUp"; readonly allowCommands?: boolean },
    ) => {
      submits.push({ sessionRef, text, deliverAs: options?.deliverAs });
      return {} as never;
    },
  };
  const owner = createOrchestrationOwner(
    host as unknown as Parameters<typeof createOrchestrationOwner>[0],
  );
  return { owner, cancels, submits };
}

test("running target with interrupt:true cancels first and starts a new turn", async () => {
  const { owner, cancels, submits } = makeHost({ status: "running", cancelBehavior: "resolve" });

  const result = await owner.sendMessageToThreadToolResult(parentRef, {
    threadId: "child",
    message: "stop and pivot",
    interrupt: true,
  });

  expect(cancels).toEqual([childRef]);
  expect(submits).toHaveLength(1);
  expect(submits[0]?.deliverAs).toBe("followUp");
  expect(submits[0]?.text).toBe("stop and pivot");
  expect(result.details.interrupted).toBe(true);
  expect(result.details.status).toBe("sent");
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  expect(text).toContain("Interrupted thread child");
});

test("running target without interrupt steers without cancelling", async () => {
  const { owner, cancels, submits } = makeHost({ status: "running", cancelBehavior: "resolve" });

  const result = await owner.sendMessageToThreadToolResult(parentRef, {
    threadId: "child",
    message: "keep going, but note this",
  });

  expect(cancels).toHaveLength(0);
  expect(submits).toHaveLength(1);
  expect(submits[0]?.deliverAs).toBe("steer");
  expect(result.details.interrupted).toBeUndefined();
});

test("idle target with interrupt:true sends unchanged without cancelling", async () => {
  const { owner, cancels, submits } = makeHost({ status: "idle", cancelBehavior: "resolve" });

  const result = await owner.sendMessageToThreadToolResult(parentRef, {
    threadId: "child",
    message: "next step",
    interrupt: true,
  });

  expect(cancels).toHaveLength(0);
  expect(submits).toHaveLength(1);
  expect(submits[0]?.deliverAs).toBe("followUp");
  expect(result.details.interrupted).toBeUndefined();
});

test("a rejected cancel still delivers the message as not interrupted", async () => {
  const { owner, cancels, submits } = makeHost({ status: "running", cancelBehavior: "reject" });

  const result = await owner.sendMessageToThreadToolResult(parentRef, {
    threadId: "child",
    message: "never lose this",
    interrupt: true,
  });

  expect(cancels).toEqual([childRef]);
  expect(submits).toHaveLength(1);
  expect(submits[0]?.text).toBe("never lose this");
  expect(result.details.interrupted).toBeUndefined();
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  expect(text).not.toContain("Interrupted thread");
});

test("interrupt:true submits only after the session reports non-running", async () => {
  const order: string[] = [];
  let status: "running" | "idle" = "running";
  let listener: ((event: never) => void) | undefined;
  const host = {
    driver: {
      cancelCurrentRun: async (sessionRef: SessionRef) => {
        expect(sessionRef).toEqual(childRef);
        order.push("cancel");
        // Settle like a real driver: the run ends just after the cancel.
        setTimeout(() => {
          status = "idle";
          order.push("settled-event");
          listener?.({ type: "runCompleted", sessionRef: childRef } as never);
        }, 10);
      },
      createSession: async () => {
        throw new Error("not used");
      },
      setChildIsolation: () => {},
      sendCustomMessage: async () => {},
    },
    initialize: async () => {},
    orchestrationState: () => ({
      selectedWorkspaceId: "ws",
      selectedSessionId: "parent",
      workspaces: [
        {
          id: "ws",
          sessions: [
            {
              id: "parent",
              title: "Parent",
              status: "running",
              updatedAt: "2026-10-28T00:00:00.000Z",
              preview: "",
            },
            {
              id: "child",
              title: "Child",
              status,
              updatedAt: "2026-10-28T00:00:00.000Z",
              preview: "",
            },
          ],
        },
      ],
      orchestrationChildren: [],
    }),
    replaceOrchestrationChildren: () => {},
    refreshState: async () => ({}) as never,
    emit: () => ({}) as never,
    withError: async () => ({}) as never,
    persistUiState: async () => {},
    workspaceRefFromState: () => ({ workspaceId: "ws", path: "/tmp/ws" }),
    sessionFromState: (ref: SessionRef) =>
      ref.sessionId === childRef.sessionId
        ? { status, title: "Child", updatedAt: "2026-10-28T00:00:00.000Z" }
        : ref.sessionId === parentRef.sessionId
          ? { status: "running", title: "Parent", updatedAt: "2026-10-28T00:00:00.000Z" }
          : undefined,
    ensureSessionReady: async () => undefined,
    ensureSessionSubscription: async () => {},
    subscribeToSessionEvents: (l: (event: never) => void) => {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
    updateSessionConfig: () => {},
    isOrchestratorSession: () => true,
    sidekickModelFor: () => undefined,
    sessionModelFor: () => undefined,
    buildCreateSessionOptions: async () => undefined,
    getQueuedComposerMessages: () => [],
    seedSession: () => {},
    transcriptFor: () => [],
    transcriptForKey: () => [],
    replaceTranscript: () => {},
    isTranscriptLoaded: () => true,
    getSessionError: () => undefined,
    setSessionError: () => {},
    submitComposerToSession: async (
      sessionRef: SessionRef,
      text: string,
      _attachments: readonly never[],
      options?: { readonly deliverAs?: "steer" | "followUp"; readonly allowCommands?: boolean },
    ) => {
      expect(sessionRef).toEqual(childRef);
      // The submit must observe the settled state, proving it waited.
      order.push(`submit:${status}`);
      expect(options?.deliverAs).toBe("followUp");
      expect(text).toBe("stop and pivot");
      return {} as never;
    },
  };
  const owner = createOrchestrationOwner(
    host as unknown as Parameters<typeof createOrchestrationOwner>[0],
  );

  const result = await owner.sendMessageToThreadToolResult(parentRef, {
    threadId: "child",
    message: "stop and pivot",
    interrupt: true,
  });

  expect(order).toEqual(["cancel", "settled-event", "submit:idle"]);
  expect(result.details.interrupted).toBe(true);
});

test("send_message_to_thread exposes interrupt and teaches interrupting drifters", async () => {
  const sent: Array<{ threadId: string; message: string; interrupt?: boolean }> = [];
  const bridge = {
    createChildThread: async () => {
      throw new Error("not used");
    },
    listThreads: async () => {
      throw new Error("not used");
    },
    readThread: async () => {
      throw new Error("not used");
    },
    sendMessageToThread: async (
      _ctx: unknown,
      input: { readonly threadId: string; readonly message: string; readonly interrupt?: boolean },
    ) => {
      sent.push({ ...input });
      return { content: [{ type: "text" as const, text: "ok" }], details: {} as never };
    },
  };
  const tool = createOrchestrationRuntimeTools(
    bridge as unknown as Parameters<typeof createOrchestrationRuntimeTools>[0],
  ).find((entry) => entry.name === sendMessageToThreadToolName);
  expect(tool).toBeDefined();
  const parameters = tool?.parameters as { properties?: Record<string, unknown> } | undefined;
  expect(parameters?.properties).toMatchObject({ interrupt: { type: "boolean" } });
  expect((tool?.promptGuidelines ?? []).some((line) => line.includes("interrupt"))).toBe(true);

  await tool?.execute(
    "call-1",
    { thread_id: "child", message: "pivot now", interrupt: true },
    undefined,
    undefined,
    {},
  );
  expect(sent).toEqual([{ threadId: "child", message: "pivot now", interrupt: true }]);

  await tool?.execute(
    "call-2",
    { thread_id: "child", message: "keep going" },
    undefined,
    undefined,
    {},
  );
  expect(sent[1]).toEqual({ threadId: "child", message: "keep going" });
});
