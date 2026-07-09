import OpenAI from "openai";
import type { FypSettings } from "../settings";

const UAT_GATEWAY_URL = "https://fyp-gateway.meow-d.workers.dev/v1";
const UAT_MODEL = "openai/gpt-4o-mini";
const MAX_TOOL_ROUNDS = 8;

export const AUTO_COMPACT_TOKENS = 80_000;

export type AgentMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export type ToolHandlers = {
  search_vault: (query: string, limit?: number) => Promise<string>;
  read_note: (path: string) => Promise<string>;
  get_linked_notes: (path: string) => Promise<string>;
  edit_note: (path: string, content: string) => Promise<string>;
  create_note: (path: string, content: string) => Promise<string>;
  delete_note: (path: string) => Promise<string>;
};

export const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_vault",
      description: "Semantic search across the vault. Returns relevant note titles, paths, and content previews.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          limit: { type: "number", description: "Maximum number of results (1–10, default 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_note",
      description: "Read the full content of a specific note by its vault path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Vault-relative file path (e.g. 'folder/note.md')" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_linked_notes",
      description: "Get paths of notes linked to or from a given note (one-hop neighbours in the wikilink graph).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Vault-relative file path" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_note",
      description: "Overwrite the full content of a specific note. Always call read_note first to get the current content before editing.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Vault-relative file path (e.g. 'folder/note.md')" },
          content: { type: "string", description: "New full markdown content for the note" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_note",
      description: "Create a new note at the given vault path. Fails if the note already exists.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Vault-relative file path including .md extension (e.g. 'folder/new-note.md')" },
          content: { type: "string", description: "Initial markdown content for the note" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_note",
      description: "Permanently delete a note from the vault. Use with caution — this cannot be undone.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Vault-relative file path of the note to delete" },
        },
        required: ["path"],
      },
    },
  },
];

function makeClient(settings: FypSettings): OpenAI {
  if (!settings.llmApiKey) throw new Error("No API key configured — check plugin settings.");
  const baseURL = settings.llmProvider === "uat" ? UAT_GATEWAY_URL : settings.llmBaseUrl;
  return new OpenAI({ apiKey: settings.llmApiKey, baseURL, dangerouslyAllowBrowser: true });
}

/**
 * Some OpenAI-compatible providers reject a message outright if it carries
 * an empty `tool_calls` array, or if a `tool` message's `tool_call_id`
 * doesn't match any tool call in the same list (e.g. after history was
 * truncated/compacted mid tool-call chain, or loaded from an older stored
 * conversation shape). Strip those degenerate shapes before every request.
 */
function sanitizeMessages(msgs: AgentMessage[]): AgentMessage[] {
  const validToolCallIds = new Set<string>();
  for (const msg of msgs) {
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) validToolCallIds.add(tc.id);
    }
  }

  const cleaned: AgentMessage[] = [];
  for (const msg of msgs) {
    if (msg.role === "assistant" && msg.tool_calls?.length === 0) {
      const { tool_calls, ...rest } = msg;
      void tool_calls;
      cleaned.push(rest as AgentMessage);
      continue;
    }
    if (msg.role === "tool" && !validToolCallIds.has(msg.tool_call_id)) continue;
    cleaned.push(msg);
  }
  return cleaned;
}

function msgContent(msg: AgentMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) return JSON.stringify(msg.content);
  return "";
}

/** Rough token count: 4 chars ≈ 1 token, plus 4 overhead per message. */
export function estimateTokens(msgs: AgentMessage[]): number {
  return msgs.reduce((total, m) => total + Math.ceil(msgContent(m).length / 4) + 4, 3);
}

export const SUMMARY_PREFIX = "[Conversation summary]";

/**
 * Summarise the oldest messages in the chain (keeping the last `keepLast`
 * untouched) using the LLM. Returns the compacted chain.
 */
export async function compactHistory(
  msgs: AgentMessage[],
  settings: FypSettings,
  keepLast = 6,
): Promise<AgentMessage[]> {
  if (msgs.length <= keepLast) return msgs;

  const toSummarize = msgs.slice(0, msgs.length - keepLast);
  const toKeep = msgs.slice(msgs.length - keepLast);

  const lines = toSummarize
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content as string}`);

  if (lines.length === 0) return msgs;

  const client = makeClient(settings);
  const model = settings.llmProvider === "uat" ? UAT_MODEL : settings.llmModel;

  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content: "Summarise the following conversation concisely but completely, preserving all key facts, questions, answers, and any context that would be needed to continue the conversation.",
      },
      { role: "user", content: lines.join("\n\n") },
    ],
  });

  const summary = response.choices[0]?.message?.content ?? "(no summary)";
  return [
    { role: "system", content: `${SUMMARY_PREFIX}\n\n${summary}` } as AgentMessage,
    ...sanitizeMessages(toKeep),
  ];
}

export interface AgentCallbacks {
  onText: (delta: string) => void;
  onToolCall?: (call: { id: string; name: string; args: string }) => void;
  onToolResult?: (result: { id: string; name: string; content: string }) => void;
  onStatus?: (status: string) => void;
}

/**
 * Run the agentic loop with streaming.
 * Returns the full message chain for history storage. Callbacks stream the
 * assistant's text, its tool calls, and the tool results as they happen.
 */
export async function runAgentLoop(
  history: AgentMessage[],
  settings: FypSettings,
  tools: ToolHandlers,
  cb: AgentCallbacks,
): Promise<AgentMessage[]> {
  const client = makeClient(settings);
  const model = settings.llmProvider === "uat" ? UAT_MODEL : settings.llmModel;
  const msgs: AgentMessage[] = sanitizeMessages(history);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const stream = await client.chat.completions.create({
      model,
      messages: sanitizeMessages(msgs),
      tools: TOOLS,
      tool_choice: "auto",
      stream: true,
    });

    let content = "";
    const tcMap = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        cb.onText(delta.content);
      }

      for (const tc of delta.tool_calls ?? []) {
        if (!tcMap.has(tc.index)) {
          tcMap.set(tc.index, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
        }
        const entry = tcMap.get(tc.index)!;
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name && !entry.name) entry.name = tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
      }
    }

    const toolCalls = tcMap.size > 0
      ? Array.from(tcMap.entries())
          .sort(([a], [b]) => a - b)
          .map(([, tc]) => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.args } }))
      : undefined;

    msgs.push(toolCalls
      ? { role: "assistant", content: content || null, tool_calls: toolCalls }
      : { role: "assistant", content },
    );

    if (!toolCalls) return msgs;

    for (const tc of toolCalls) {
      cb.onToolCall?.({ id: tc.id, name: tc.function.name, args: tc.function.arguments });
      let result: string;
      try {
        const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        cb.onStatus?.(`${tc.function.name.replace(/_/g, " ")}…`);
        switch (tc.function.name) {
          case "search_vault":
            result = await tools.search_vault(args.query as string, args.limit as number | undefined);
            break;
          case "read_note":
            result = await tools.read_note(args.path as string);
            break;
          case "get_linked_notes":
            result = await tools.get_linked_notes(args.path as string);
            break;
          case "edit_note":
            result = await tools.edit_note(args.path as string, args.content as string);
            break;
          case "create_note":
            result = await tools.create_note(args.path as string, args.content as string);
            break;
          case "delete_note":
            result = await tools.delete_note(args.path as string);
            break;
          default:
            result = `Unknown tool: ${tc.function.name}`;
        }
      } catch (e) {
        result = `Tool error: ${(e as Error).message}`;
      }
      cb.onToolResult?.({ id: tc.id, name: tc.function.name, content: result });
      msgs.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }

  throw new Error("Agent exceeded maximum reasoning rounds.");
}

export async function callLLMOnce(messages: AgentMessage[], settings: FypSettings): Promise<string> {
  const client = makeClient(settings);
  const model = settings.llmProvider === "uat" ? UAT_MODEL : settings.llmModel;
  const resp = await client.chat.completions.create({ model, messages });
  return resp.choices[0]?.message?.content ?? "";
}
