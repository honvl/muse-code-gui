/**
 * Suggested next-prompt (ghost text) helpers.
 *
 * After a run completes, pi-gui asks a cheap model for one follow-up prompt
 * and shows it as grey composer placeholder text. Tab accepts it into the
 * draft. These pure helpers build the model input and sanitize its output;
 * the actual model call lives on RuntimeSupervisor, which owns ModelRuntime.
 */

export interface SuggestionSourceMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

const MAX_EXCERPT_CHARS = 3000;
const MAX_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 600;
const MAX_SUGGESTION_CHARS = 220;

export const SUGGESTION_SYSTEM_PROMPT =
  "You write the single most useful next message the user can send to their AI coding agent " +
  "to continue this coding session. This is a coding agent that can read and edit code, run " +
  "commands, and explain things. " +
  "Output ONLY that message, word-for-word as the user would send it: a direct instruction or " +
  "question to the agent (for example starting with a verb like Fix, Add, Run, Explain, Show, " +
  "Review). Write in the user's voice, addressing the agent — never advise the user, never start " +
  "with \"You should\", \"You could\", \"Consider\", \"Make sure you\", or \"Ask the user\". Do not " +
  "narrate, describe the user, or explain yourself. No quotes, no bullets, no preamble, no " +
  "explanation. One or two sentences, ready to send.";

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * Render recent transcript messages as compact `Role: text` lines for the
 * suggester model, newest-relevant last, capped by message and total length.
 */
export function buildSuggestionExcerpt(messages: readonly SuggestionSourceMessage[]): string {
  const lines: string[] = [];
  let total = 0;
  const recent = messages.filter((message) => message.text.trim().length > 0).slice(-MAX_MESSAGES);
  for (const message of recent) {
    const text = truncate(message.text.trim(), MAX_MESSAGE_CHARS);
    const line = `${message.role === "assistant" ? "Assistant" : "User"}: ${text}`;
    if (total + line.length > MAX_EXCERPT_CHARS) {
      break;
    }
    lines.push(line);
    total += line.length;
  }
  return lines.join("\n\n");
}

/**
 * Prefixes that address the human instead of the agent. A usable suggestion
 * is written in the user's voice as a direct instruction or question to the
 * agent ("Fix…", "Run…", "Explain…"); anything opening with advice to the
 * user ("You should…", "Consider…") or narration ("Here's…", "I suggest…")
 * is rejected so no ghost text shows instead of a bad one.
 */
const META_ADVICE_PREFIX =
  /^(you\s+(should|ought to|could|can|might|need to|have to|must)\b|consider\b|make sure you\b|don'?t forget to\b|remember to\b|try asking\b|ask (the )?user\b|as an ai\b|here\b|i (suggest|recommend|think|would)\b|what (do|would) you (want|like)\b|how (do|would) you\b|do you want\b)/i;

const LEADING_LABEL_PREFIX =
  /^(user|prompt|suggestion|follow[- ]?up|next (prompt|step|message))\s*:\s*/i;

/** Normalize a model reply into a one-shot composer prompt, or undefined when unusable. */
export function sanitizeSuggestedPrompt(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return undefined;
  }
  const stripped = collapsed
    .replace(/^["'“”‘’`]+/, "")
    .replace(/["'“”‘’`]+$/, "")
    .replace(/^[-*•\d.)\s]+/, "")
    .replace(LEADING_LABEL_PREFIX, "")
    .trim();
  if (!stripped) {
    return undefined;
  }
  if (META_ADVICE_PREFIX.test(stripped)) {
    return undefined;
  }
  return truncate(stripped, MAX_SUGGESTION_CHARS);
}
