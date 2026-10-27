import { expect, test } from "@playwright/test";
import {
  formatElapsed,
  truncateCommand,
} from "../../src/features/conversation/session-task-format";

test("truncateCommand shortens whitespace-collapsed commands", () => {
  expect(truncateCommand("echo hi")).toBe("echo hi");
  expect(truncateCommand("  echo   hi\nthere  ")).toBe("echo hi there");
  expect(truncateCommand("x".repeat(100), 80).length).toBeLessThanOrEqual(80);
});

test("formatElapsed renders seconds then minutes", () => {
  const now = Date.parse("2026-10-27T12:00:00.000Z");
  expect(formatElapsed(undefined, now)).toBe("");
  expect(formatElapsed("not-a-date", now)).toBe("");
  expect(formatElapsed(new Date(now - 5_000).toISOString(), now)).toBe("5s");
  expect(formatElapsed(new Date(now - 65_000).toISOString(), now)).toBe("1m 5s");
  expect(formatElapsed(new Date(now - 120_000).toISOString(), now)).toBe("2m");
});
