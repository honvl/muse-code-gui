import { expect, test } from "@playwright/test";
import { runningAgentCallIds } from "../../src/features/threads/use-activity-auto-open";

function toolCall(callId: string, toolName: string, status: string) {
  return { kind: "tool", id: callId, callId, toolName, status, label: toolName };
}

test("runningAgentCallIds finds only running agent delegations", () => {
  const transcript = [
    { kind: "message", role: "user", content: "hi" },
    toolCall("call-1", "agent", "running"),
    toolCall("call-2", "bash", "running"),
    toolCall("call-3", "agent", "success"),
    toolCall("call-4", "agent", "error"),
  ];
  expect(runningAgentCallIds(transcript as never)).toEqual(["call-1"]);
});

test("runningAgentCallIds ignores pins and missing transcript", () => {
  expect(runningAgentCallIds(undefined)).toEqual([]);
  expect(runningAgentCallIds([])).toEqual([]);
  const transcript = [
    { kind: "pin", id: "pin-1" },
    { kind: "summary", id: "sum-1" },
  ];
  expect(runningAgentCallIds(transcript as never)).toEqual([]);
});

test("runningAgentCallIds skips malformed tool entries", () => {
  const transcript = [
    { kind: "tool", id: "x", status: "running" },
    toolCall("call-5", "agent", "running"),
  ];
  expect(runningAgentCallIds(transcript as never)).toEqual(["call-5"]);
});
