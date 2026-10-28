import { expect, test } from "@playwright/test";
import {
  CHILD_REPORT_SUFFIX,
  DEFAULT_SUCCESS_CRITERIA,
  DEFAULT_VERIFY,
  SCOPE_BRIEF_WARNING,
  briefWarningsFromParams,
  createChildThreadBriefFromParams,
  createChildThreadToolName,
  createOrchestrationRuntimeTools,
} from "../../electron/orchestration/orchestration-runtime";

function makeTool() {
  const seen: Array<{ prompt: string }> = [];
  const bridge = {
    createChildThread: async (_ctx: unknown, input: { prompt: string }) => {
      seen.push({ prompt: input.prompt });
      return {
        content: [{ type: "text" as const, text: "Created child thread: Probe" }],
        details: {
          action: "pi_gui_create_child_thread",
          prompt: input.prompt,
          childThreadId: "thread-1",
        },
      };
    },
    listThreads: async (): Promise<never> => {
      throw new Error("not used");
    },
    readThread: async (): Promise<never> => {
      throw new Error("not used");
    },
    sendMessageToThread: async (): Promise<never> => {
      throw new Error("not used");
    },
  };
  const tool = createOrchestrationRuntimeTools(
    bridge as unknown as Parameters<typeof createOrchestrationRuntimeTools>[0],
  ).find((entry) => entry.name === createChildThreadToolName);
  return { tool, seen };
}

test("a bare brief delivers the default success criteria and verify text", () => {
  const brief = createChildThreadBriefFromParams({ prompt: "Fix the leak." });
  expect(brief).toContain(`Success criteria: ${DEFAULT_SUCCESS_CRITERIA}`);
  expect(brief).toContain(`Verify: ${DEFAULT_VERIFY}`);
  expect(brief?.endsWith(CHILD_REPORT_SUFFIX)).toBe(true);
});

test("a bare call hints only scope, never success criteria or verify", async () => {
  expect(briefWarningsFromParams({ prompt: "Fix the leak." })).toEqual([SCOPE_BRIEF_WARNING]);

  const { tool, seen } = makeTool();
  expect(tool).toBeDefined();
  const result = await tool!.execute(
    "call-1",
    { prompt: "Fix the leak." },
    undefined,
    undefined,
    {},
  );
  const hintLines = result.content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("\n")
    .split("\n")
    .filter((line) => line.includes("Brief hint"));
  expect(hintLines).toHaveLength(1);
  expect(hintLines[0]).toContain("add scope");
  expect(hintLines.join(" ")).not.toContain("success_criteria");
  expect(hintLines.join(" ")).not.toContain("Verify the lead");
  // The delivered brief still carries the defaulted blocks for the child.
  expect(seen).toHaveLength(1);
  expect(seen[0]?.prompt).toContain(DEFAULT_SUCCESS_CRITERIA);
  expect(seen[0]?.prompt).toContain(DEFAULT_VERIFY);
});

test("explicit success criteria and verify replace the defaults", () => {
  const brief = createChildThreadBriefFromParams({
    prompt: "Fix the leak.",
    scope: "apps/desktop",
    success_criteria: "Leak gone under soak.",
    verify: "pnpm check-leak",
  });
  expect(brief).toContain("Success criteria: Leak gone under soak.");
  expect(brief).toContain("Verify: pnpm check-leak");
  expect(brief).not.toContain(DEFAULT_SUCCESS_CRITERIA);
  expect(brief).not.toContain(DEFAULT_VERIFY);
});
