import { vi, describe, it, expect, beforeEach } from "vitest";
import type { FypSettings } from "../settings";

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
  })),
}));

import { runAgentLoop, TOOLS, estimateTokens, compactHistory, SUMMARY_PREFIX } from "../core/llm";

const baseSettings: FypSettings = {
  enableIndexing: true,
  modelPath: "",
  topK: 10,
  minSimilarity: 0.5,
  llmProvider: "openrouter",
  llmApiKey: "test-key",
  llmBaseUrl: "http://localhost/v1",
  llmModel: "test-model",
  setupCompleted: true,
  showWelcomeOnStartup: false,
};

const noopTools = {
  search_vault: vi.fn().mockResolvedValue("results"),
  read_note: vi.fn().mockResolvedValue("content"),
  get_linked_notes: vi.fn().mockResolvedValue("links"),
  edit_note: vi.fn().mockResolvedValue("updated"),
  create_note: vi.fn().mockResolvedValue("created"),
  delete_note: vi.fn().mockResolvedValue("deleted"),
};

// Streaming mock helpers

function makeStream<T>(items: T[]): AsyncIterable<T> {
  return (async function* () { for (const item of items) yield item; })();
}

/** Stream that yields a single text delta chunk */
function textStream(content: string) {
  return makeStream([
    { choices: [{ delta: { content } }] },
  ]);
}

/** Stream that yields no text content (used when finishing with tool calls) */
function emptyStream() {
  return makeStream([{ choices: [{ delta: {} }] }]);
}

/** Stream that yields tool call deltas */
function toolCallStream(name: string, args: Record<string, unknown>, id = "call_1") {
  return makeStream([
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
      }],
    },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// TOOLS definition

describe("TOOLS", () => {
  it("defines exactly the six expected tools", () => {
    const names = TOOLS
      .filter((t) => t.type === "function")
      .map((t) => t.function.name);
    expect(names).toEqual(["search_vault", "read_note", "get_linked_notes", "edit_note", "create_note", "delete_note"]);
  });

  it("each tool has required parameters", () => {
    for (const tool of TOOLS) {
      expect(tool.type).toBe("function");
      if (tool.type === "function") expect(tool.function.parameters).toBeDefined();
    }
  });
});

// estimateTokens

describe("estimateTokens", () => {
  it("returns a positive number for non-empty messages", () => {
    const msgs = [{ role: "user" as const, content: "hello world" }];
    expect(estimateTokens(msgs)).toBeGreaterThan(0);
  });

  it("increases with more content", () => {
    const short = [{ role: "user" as const, content: "hi" }];
    const long = [{ role: "user" as const, content: "hi ".repeat(500) }];
    expect(estimateTokens(long)).toBeGreaterThan(estimateTokens(short));
  });

  it("increases with more messages", () => {
    const one = [{ role: "user" as const, content: "hello" }];
    const two = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "world" },
    ];
    expect(estimateTokens(two)).toBeGreaterThan(estimateTokens(one));
  });
});

// compactHistory

describe("compactHistory", () => {
  it("returns messages unchanged when count <= keepLast", async () => {
    const msgs = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];
    const result = await compactHistory(msgs, baseSettings, 6);
    expect(result).toEqual(msgs);
  });

  it("calls the LLM and returns a summary message prepended to the kept tail", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Earlier: user asked about PKM." } }],
    });
    const msgs = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `message ${i}`,
    }));

    const result = await compactHistory(msgs, baseSettings, 4);

    expect(result[0].role).toBe("system");
    expect(typeof result[0].content).toBe("string");
    expect((result[0].content as string).startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(result.slice(1)).toEqual(msgs.slice(-4));
  });

  it("uses the summary text returned by the LLM", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Summary text here." } }],
    });
    const msgs = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `msg ${i}`,
    }));
    const result = await compactHistory(msgs, baseSettings, 4);
    expect((result[0].content as string)).toContain("Summary text here.");
  });
});

// runAgentLoop

describe("runAgentLoop", () => {
  it("throws when API key is missing", async () => {
    const settings = { ...baseSettings, llmApiKey: "" };
    await expect(
      runAgentLoop([], settings, noopTools, { onText: vi.fn() })
    ).rejects.toThrow("No API key configured");
  });

  it("calls onChunk with text when model responds directly", async () => {
    mockCreate.mockReturnValueOnce(textStream("Hello world"));
    const chunks: string[] = [];
    await runAgentLoop([{ role: "user", content: "hi" }], baseSettings, noopTools, { onText: (c) => chunks.push(c) });
    expect(chunks).toEqual(["Hello world"]);
  });

  it("does not call onChunk when stream yields no content", async () => {
    mockCreate.mockReturnValueOnce(emptyStream());
    const onChunk = vi.fn();
    await runAgentLoop([], baseSettings, noopTools, { onText: onChunk });
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("returns the full message chain", async () => {
    mockCreate.mockReturnValueOnce(textStream("reply"));
    const msgs = await runAgentLoop(
      [{ role: "user", content: "hi" }], baseSettings, noopTools, { onText: vi.fn() }
    );
    // should include the original user message + new assistant message
    expect(msgs.some((m) => m.role === "user")).toBe(true);
    expect(msgs.some((m) => m.role === "assistant")).toBe(true);
  });

  it("executes search_vault tool call then returns final text", async () => {
    const tools = { ...noopTools, search_vault: vi.fn().mockResolvedValue("Note A: preview") };
    mockCreate
      .mockReturnValueOnce(toolCallStream("search_vault", { query: "PKM" }))
      .mockReturnValueOnce(textStream("Found it"));

    const chunks: string[] = [];
    await runAgentLoop([{ role: "user", content: "find PKM" }], baseSettings, tools, { onText: (c) => chunks.push(c) });

    expect(tools.search_vault).toHaveBeenCalledWith("PKM", undefined);
    expect(chunks).toEqual(["Found it"]);
  });

  it("executes read_note tool call", async () => {
    const tools = { ...noopTools, read_note: vi.fn().mockResolvedValue("# My Note\n\nContent.") };
    mockCreate
      .mockReturnValueOnce(toolCallStream("read_note", { path: "notes/my-note.md" }))
      .mockReturnValueOnce(textStream("Done"));

    await runAgentLoop([], baseSettings, tools, { onText: vi.fn() });
    expect(tools.read_note).toHaveBeenCalledWith("notes/my-note.md");
  });

  it("executes get_linked_notes tool call", async () => {
    const tools = { ...noopTools, get_linked_notes: vi.fn().mockResolvedValue("- notes/b.md") };
    mockCreate
      .mockReturnValueOnce(toolCallStream("get_linked_notes", { path: "notes/a.md" }))
      .mockReturnValueOnce(textStream("Done"));

    await runAgentLoop([], baseSettings, tools, { onText: vi.fn() });
    expect(tools.get_linked_notes).toHaveBeenCalledWith("notes/a.md");
  });

  it("executes edit_note tool call", async () => {
    const tools = { ...noopTools, edit_note: vi.fn().mockResolvedValue("Note updated successfully.") };
    mockCreate
      .mockReturnValueOnce(toolCallStream("edit_note", { path: "notes/a.md", content: "# New content" }))
      .mockReturnValueOnce(textStream("Done"));

    await runAgentLoop([], baseSettings, tools, { onText: vi.fn() });
    expect(tools.edit_note).toHaveBeenCalledWith("notes/a.md", "# New content");
  });

  it("returns tool error message and continues when a tool throws", async () => {
    const tools = { ...noopTools, read_note: vi.fn().mockRejectedValue(new Error("Disk full")) };
    mockCreate
      .mockReturnValueOnce(toolCallStream("read_note", { path: "bad.md" }))
      .mockReturnValueOnce(textStream("Handled"));

    const chunks: string[] = [];
    await runAgentLoop([], baseSettings, tools, { onText: (c) => chunks.push(c) });
    expect(chunks).toEqual(["Handled"]);

    const secondCallMsgs = mockCreate.mock.calls[1][0].messages as Array<{ role: string; content: string }>;
    const toolMsg = secondCallMsgs.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("Tool error");
  });

  it("handles unknown tool name gracefully", async () => {
    mockCreate
      .mockReturnValueOnce(toolCallStream("nonexistent_tool", {}))
      .mockReturnValueOnce(textStream("Done"));

    await runAgentLoop([], baseSettings, noopTools, { onText: vi.fn() });
    const secondCallMsgs = mockCreate.mock.calls[1][0].messages as Array<{ role: string; content: string }>;
    const toolMsg = secondCallMsgs.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("Unknown tool");
  });

  it("throws after exceeding MAX_TOOL_ROUNDS", async () => {
    // Must use mockImplementation so each call gets a fresh (non-exhausted) stream
    mockCreate.mockImplementation(() => toolCallStream("search_vault", { query: "loop" }));

    await expect(
      runAgentLoop([], baseSettings, noopTools, { onText: vi.fn() })
    ).rejects.toThrow("exceeded maximum");
  });

  it("calls onStatus with tool name during execution", async () => {
    mockCreate
      .mockReturnValueOnce(toolCallStream("search_vault", { query: "test" }))
      .mockReturnValueOnce(textStream("Done"));

    const statuses: string[] = [];
    await runAgentLoop([], baseSettings, noopTools, { onText: vi.fn(), onStatus: (s) => statuses.push(s) });
    expect(statuses[0]).toContain("search vault");
  });

  it("uses UAT gateway URL when provider is 'uat'", async () => {
    const OpenAI = (await import("openai")).default;
    mockCreate.mockReturnValueOnce(textStream("ok"));
    const settings = { ...baseSettings, llmProvider: "uat" as const, llmApiKey: "key" };

    await runAgentLoop([], settings, noopTools, { onText: vi.fn() });

    const constructorCall = vi.mocked(OpenAI).mock.calls.at(-1)?.[0] as { baseURL?: string } | undefined;
    expect(constructorCall?.baseURL).toContain("fyp-gateway");
  });

  it("passes history messages to the API", async () => {
    mockCreate.mockReturnValueOnce(textStream("reply"));
    const history = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "hello" },
    ];

    await runAgentLoop(history, baseSettings, noopTools, { onText: vi.fn() });

    const sentMsgs = mockCreate.mock.calls[0][0].messages as Array<{ role: string; content: string }>;
    expect(sentMsgs.some((m) => m.role === "system" && m.content === "sys")).toBe(true);
    expect(sentMsgs.some((m) => m.role === "user" && m.content === "hello")).toBe(true);
  });

  it("streams text across multiple delta chunks", async () => {
    // two chunks from the same model response
    mockCreate.mockReturnValueOnce(makeStream([
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: " world" } }] },
    ]));
    const chunks: string[] = [];
    await runAgentLoop([], baseSettings, noopTools, { onText: (c) => chunks.push(c) });
    expect(chunks).toEqual(["Hello", " world"]);
  });
});
