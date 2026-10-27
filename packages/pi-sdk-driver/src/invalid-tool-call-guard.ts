import type { ContextWithSystemEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Per-LLM-request safety net for poisoned tool-call history.
 *
 * Strict providers (notably Meta via openai-responses) reject an entire
 * request with `400 invalid_request_error` when the history contains:
 * - a `toolCall` with empty/missing arguments (the model sometimes emits
 *   `bash` with `{}`, e.g. when the response hits the output token limit and
 *   arguments get truncated), or
 * - a `toolResult` whose call never executed (`Validation failed ...`,
 *   `... was not executed: the response hit the output token limit ...`), or
 * - a `toolResult` with no matching `toolCall` in the payload
 *   (`No function call found for function call output ...`).
 *
 * Such pairs can be created *and* consumed inside a single agent turn, so a
 * before-prompt repair never sees them before the failing request. This hook
 * (`context_with_system` fires before every LLM call) strips those blocks
 * from the outgoing payload only. Persisted history and the visible
 * transcript are untouched; durable repair stays in
 * `sanitizeInvalidToolCallHistory`.
 *
 * The filter keeps call/result pairs consistent: dropping a call always drops
 * its results, and orphan results are dropped. Everything else is returned by
 * reference; when nothing is poisoned the handler returns void so pi sends
 * the original payload.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isInvalidToolResult(message: Record<string, unknown>): boolean {
  if (message.isError !== true) return false;
  const text = toolResultText(message).trim();
  return (
    /^Validation failed for tool "[^"\n]+":/i.test(text) ||
    /^Tool call "[^"\n]+" was not executed: the response hit the output token limit, so its arguments may be truncated\./i.test(
      text,
    )
  );
}

function toolResultText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => isRecord(part) && part.type === "text")
    .map((part) => (part as { text?: unknown }).text)
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

function isEmptyBashCall(block: Record<string, unknown>): boolean {
  if (block.type !== "toolCall" || block.name !== "bash") return false;
  const args = block.arguments;
  if (!isRecord(args)) return true;
  const command = args.command;
  return typeof command !== "string" || command.trim().length === 0;
}

type ProviderMessages = ContextWithSystemEvent["messages"];

export function filterPoisonedProviderMessages(
  messages: ProviderMessages,
): ProviderMessages | undefined {
  const invalidCallIds = new Set<string>();

  for (const raw of messages) {
    const message = raw as Record<string, unknown>;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (
          isRecord(block) &&
          block.type === "toolCall" &&
          typeof block.id === "string" &&
          isEmptyBashCall(block)
        ) {
          invalidCallIds.add(block.id);
        }
      }
    } else if (message.role === "toolResult") {
      const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      if (toolCallId && isInvalidToolResult(message)) {
        invalidCallIds.add(toolCallId);
      }
    }
  }

  // Calls surviving the filter; results without a surviving call are orphans.
  const survivingCallIds = new Set<string>();
  for (const raw of messages) {
    const message = raw as Record<string, unknown>;
    if (message.role !== "assistant") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        isRecord(block) &&
        block.type === "toolCall" &&
        typeof block.id === "string" &&
        !invalidCallIds.has(block.id)
      ) {
        survivingCallIds.add(block.id);
      }
    }
  }

  let changed = invalidCallIds.size > 0;
  const filtered: unknown[] = [];
  for (const raw of messages) {
    const message = raw as Record<string, unknown>;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const kept = message.content.filter(
        (block) =>
          !(
            isRecord(block) &&
            block.type === "toolCall" &&
            typeof block.id === "string" &&
            invalidCallIds.has(block.id)
          ),
      );
      if (kept.length !== message.content.length) {
        changed = true;
        if (kept.length === 0) continue;
        filtered.push({ ...message, content: kept });
      } else {
        filtered.push(message);
      }
    } else if (message.role === "toolResult") {
      const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      if (
        (toolCallId && invalidCallIds.has(toolCallId)) ||
        (toolCallId && !survivingCallIds.has(toolCallId))
      ) {
        changed = true;
        continue;
      }
      filtered.push(message);
    } else {
      filtered.push(message);
    }
  }

  if (!changed) return undefined;
  return filtered as unknown as ProviderMessages;
}

/** Hidden inline extension: no tools, commands, or UI. */
export function createInvalidToolCallGuardExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("context_with_system", (event) => {
      const replacement = filterPoisonedProviderMessages(event.messages);
      if (replacement) return { messages: replacement };
    });
  };
}
