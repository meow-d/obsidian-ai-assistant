import { App, ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from "obsidian";
import {
  runAgentLoop, compactHistory, estimateTokens,
  AUTO_COMPACT_TOKENS, SUMMARY_PREFIX,
  type AgentMessage,
} from "../../core/llm";
import type { VaultIndex } from "../../core/vault-index";
import type { FypSettings } from "../../settings";
import type FypPlugin from "../../main";
import { createSidebarSwitcher, SIDEBAR_VIEWS } from "../../ui/sidebar-switcher";
import { makeActivatable } from "../../ui/a11y";
import { ConversationStore } from "./store";
import { buildRagContext } from "./rag";
import { makeToolHandlers } from "./tools";

export { makeToolHandlers } from "./tools";
export const AGENT_VIEW = "fyp-agent";

const SYSTEM_PROMPT = `You are a knowledgeable assistant with access to the user's personal knowledge base (Obsidian vault).

You have tools to search and read notes. Use them to find relevant information before answering. Think step-by-step: search for relevant notes, read ones that look useful, follow links if needed, then answer based on what you found.

Always cite note titles when drawing from them. If you cannot find enough information, say so.`;

export class AgentView extends ItemView {
  private index: VaultIndex;
  private appRef: App;
  private settings: FypSettings;
  private plugin: FypPlugin;
  private store!: ConversationStore;

  private messagesEl!: HTMLElement;
  private historyEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private presetsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private historyBtn!: HTMLButtonElement;
  private showingHistory = false;
  private sending = false;

  constructor(leaf: WorkspaceLeaf, index: VaultIndex, app: App, settings: FypSettings, plugin: FypPlugin) {
    super(leaf);
    this.index = index;
    this.appRef = app;
    this.settings = settings;
    this.plugin = plugin;
  }

  getViewType(): string { return AGENT_VIEW; }
  getDisplayText(): string { return "AI agent"; }
  getIcon(): string { return "bot"; }

  async onOpen(): Promise<void> {
    this.store = new ConversationStore(this.plugin);

    const container = this.containerEl.children[1] as HTMLElement;
    container.addClass("fyp-agent");
    container.empty();

    const switcherBar = container.createEl("div", { cls: "fyp-agent-switcher-bar" });
    createSidebarSwitcher(switcherBar, SIDEBAR_VIEWS.AGENT, (viewType) => {
      if (viewType !== SIDEBAR_VIEWS.AGENT) {
        this.app.workspace.detachLeavesOfType(SIDEBAR_VIEWS.AGENT);
        this.plugin.activateViewFromSwitcher(viewType);
      }
    });

    const actionsBar = container.createEl("div", { cls: "fyp-agent-actions" });
    this.historyBtn = actionsBar.createEl("button", { text: "History", attr: { title: "Browse conversations" } });
    const newBtn = actionsBar.createEl("button", { text: "New", attr: { title: "Start new conversation" } });
    const compactBtn = actionsBar.createEl("button", { text: "Compact", attr: { title: "Summarise older messages to free up context" } });

    this.historyBtn.addEventListener("click", () => this.toggleHistory());
    newBtn.addEventListener("click", () => this.newConversation());
    compactBtn.addEventListener("click", () => this.runCompaction());

    this.historyEl = container.createEl("div", { cls: "fyp-agent-history" });
    this.historyEl.hide();

    this.messagesEl = container.createEl("div", { cls: "fyp-agent-messages" });
    this.statusEl = container.createEl("div", { cls: "fyp-agent-status" });

    const inputArea = container.createEl("div", { cls: "fyp-agent-input" });

    this.presetsEl = inputArea.createEl("div", { cls: "fyp-agent-presets" });
    const presetsEl = this.presetsEl;
    const PRESETS: { label: string; text: string }[] = [
      {
        label: "Find connections",
        text: "What notes in my vault relate to what I'm currently working on? Are there any unexpected connections I might have missed?",
      },
      {
        label: "Resurface forgotten",
        text: "What notes have I not visited recently that are relevant to my current work?",
      },
      {
        label: "Suggest links & tags",
        text: "Based on my current note, what wikilinks to other notes and what tags would you suggest adding?",
      },
      {
        label: "Clean up this note",
        text: "Review my current note and suggest improvements to its structure and clarity, without changing its meaning.",
      },
    ];

    this.inputEl = inputArea.createEl("textarea", {
      cls: "fyp-agent-textarea",
      attr: { placeholder: "Ask anything about your vault…", rows: "3" },
    });
    const sendBtn = inputArea.createEl("button", { text: "Send", cls: "mod-cta" });

    const syncPresets = () => {
      presetsEl.style.display = this.inputEl.value ? "none" : "";
    };

    for (const preset of PRESETS) {
      const btn = presetsEl.createEl("button", { cls: "fyp-preset-btn", text: preset.label });
      btn.addEventListener("click", () => {
        this.inputEl.value = preset.text;
        presetsEl.style.display = "none";
        this.inputEl.focus();
      });
    }

    const send = () => this.handleSubmit();
    sendBtn.addEventListener("click", send);
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    this.inputEl.addEventListener("input", syncPresets);

    await this.renderCurrentConversation();
  }

  appendToInput(text: string): void {
    if (this.showingHistory) this.closeHistory();
    const current = this.inputEl.value;
    this.inputEl.value = current ? `${current}\n\n${text}` : text;
    this.inputEl.focus();
  }

  private closeHistory(): void {
    this.showingHistory = false;
    this.historyEl.hide();
    this.messagesEl.show();
    this.statusEl.show();
    this.historyBtn.removeClass("active");
  }

  private toggleHistory(): void {
    if (this.showingHistory) {
      this.closeHistory();
    } else {
      this.showingHistory = true;
      this.renderHistoryPanel();
      this.historyEl.show();
      this.messagesEl.hide();
      this.statusEl.hide();
      this.historyBtn.addClass("active");
    }
  }

  private renderHistoryPanel(): void {
    this.historyEl.empty();
    const all = this.store.all;
    const hasContent = all.some((c) => c.messages.length > 0);
    if (!hasContent) {
      this.historyEl.createEl("div", { cls: "fyp-muted", text: "No conversations yet." });
      return;
    }
    for (let i = all.length - 1; i >= 0; i--) {
      const conv = all[i];
      if (conv.messages.length === 0) continue;
      const firstUser = conv.messages.find((m) => m.role === "user");
      const raw = typeof firstUser?.content === "string" ? firstUser.content : "";
      const preview = raw.length > 60 ? raw.slice(0, 60) + "…" : raw || "New conversation";
      const date = new Date(conv.created).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
      });
      const item = this.historyEl.createEl("div", {
        cls: "fyp-history-item" + (i === this.store.activeIndex ? " active" : ""),
      });
      item.createEl("div", { cls: "fyp-history-preview", text: preview });
      item.createEl("div", { cls: "fyp-history-date", text: date });
      makeActivatable(item, () => this.loadConversation(i));
    }
  }

  private async renderCurrentConversation(): Promise<void> {
    this.messagesEl.empty();
    const messages = this.store.active.messages;
    const hasVisible = messages.some(
      (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content,
    );
    if (!hasVisible) {
      this.messagesEl.createEl("div", {
        cls: "fyp-agent-empty",
        text: "Continue a chat in History, or type a message below.",
      });
    }

    // A response spans several assistant/tool messages (thinking, tool calls,
    // tool results, final answer); group them into one assistant bubble.
    let body: HTMLElement | null = null;
    const toolChips = new Map<string, HTMLElement>();

    for (const msg of messages) {
      if (msg.role === "system" && typeof msg.content === "string" && msg.content.startsWith(SUMMARY_PREFIX)) {
        body = null;
        const el = this.messagesEl.createEl("div", { cls: "fyp-message fyp-summary" });
        el.createEl("span", { cls: "fyp-message-role", text: "summary" });
        const contentEl = el.createEl("div", { cls: "fyp-message-content" });
        await MarkdownRenderer.render(this.app, msg.content.slice(SUMMARY_PREFIX.length).trimStart(), contentEl, "", this);
        continue;
      }

      if (msg.role === "user" && typeof msg.content === "string" && msg.content) {
        body = null;
        const el = this.appendMessageEl("user", "");
        (el.querySelector(".fyp-message-content") as HTMLElement).setText(msg.content);
        continue;
      }

      if (msg.role === "assistant") {
        if (!body) body = this.appendMessageEl("assistant", "").querySelector(".fyp-message-content") as HTMLElement;
        if (typeof msg.content === "string" && msg.content) {
          const textEl = body.createEl("div", { cls: "fyp-agent-text" });
          await MarkdownRenderer.render(this.app, msg.content, textEl, "", this);
        }
        for (const tc of msg.tool_calls ?? []) {
          if (tc.type !== "function") continue;
          toolChips.set(tc.id, this.appendToolChip(body, tc.function.name, tc.function.arguments));
        }
        continue;
      }

      if (msg.role === "tool" && body) {
        const id = (msg as { tool_call_id?: string }).tool_call_id;
        const chip = id ? toolChips.get(id) : undefined;
        if (chip) this.setToolResult(chip, typeof msg.content === "string" ? msg.content : "");
      }
    }
  }

  private async loadConversation(idx: number): Promise<void> {
    this.store.switchTo(idx);
    this.closeHistory();
    this.statusEl.setText("");
    await this.renderCurrentConversation();
  }

  private async newConversation(): Promise<void> {
    if (this.showingHistory) this.closeHistory();
    await this.store.newConversation();
    this.statusEl.setText("");
    await this.renderCurrentConversation();
  }

  async runCompaction(): Promise<void> {
    if (this.sending) return;
    if (this.store.active.messages.length <= 6) {
      new Notice("Not enough messages to compact.");
      return;
    }
    this.statusEl.setText("Compacting conversation history…");
    try {
      this.store.setMessages(await compactHistory(this.store.active.messages, this.settings));
      await this.store.save();
      await this.renderCurrentConversation();
    } catch (err) {
      new Notice(`Compaction failed: ${(err as Error).message}`);
    } finally {
      this.statusEl.setText("");
    }
  }

  private async handleSubmit(): Promise<void> {
    if (this.sending) return;
    const query = this.inputEl.value.trim();
    if (!query) return;

    if (this.showingHistory) this.closeHistory();

    this.sending = true;
    this.inputEl.value = "";
    this.inputEl.disabled = true;

    this.appendMessageEl("user", query);

    let ragContext = "";
    try {
      ragContext = await buildRagContext(query, this.appRef, this.index);
    } catch {
      // RAG failure is non-fatal
    }

    const systemContent = ragContext
      ? `${SYSTEM_PROMPT}\n\n## Relevant vault context\n\n${ragContext}`
      : SYSTEM_PROMPT;

    const systemMsg: AgentMessage = { role: "system", content: systemContent };
    const userMsg: AgentMessage = { role: "user", content: query };

    // Auto-compact if approaching context limit
    const estTokens = estimateTokens([systemMsg, ...this.store.active.messages, userMsg]);
    if (estTokens > AUTO_COMPACT_TOKENS) {
      this.statusEl.setText("Compacting conversation history…");
      try {
        this.store.setMessages(await compactHistory(this.store.active.messages, this.settings));
        await this.store.save();
        await this.renderCurrentConversation();
        this.appendMessageEl("user", query);
      } catch {
        // Compaction failure is non-fatal — proceed with full history
      }
      this.statusEl.setText("");
    }

    // Persist user message before the API call so it survives an Obsidian crash
    this.store.setMessages([...this.store.active.messages, userMsg]);
    await this.store.save();

    const sendHistory: AgentMessage[] = [systemMsg, ...this.store.active.messages];

    const assistantEl = this.appendMessageEl("assistant", "");
    const body = assistantEl.querySelector(".fyp-message-content") as HTMLElement;
    const loadingEl = body.createEl("span", { cls: "fyp-loading-dots" });
    const toolChips = new Map<string, HTMLElement>();

    // Track the active text block so thinking text, tool calls, and the final
    // answer render as separate interleaved blocks within one assistant bubble.
    let curText = "";
    let curTextEl: HTMLElement | null = null;
    let curStream: ReturnType<typeof this.makeStreamingRenderer> | null = null;
    const finalizeText = () => {
      const s = curStream, el = curTextEl, t = curText;
      curText = ""; curTextEl = null; curStream = null;
      if (s && el) void s.flush(t);
    };

    try {
      const tools = makeToolHandlers(this.index, this.appRef);
      const returnedMsgs = await runAgentLoop(sendHistory, this.settings, tools, {
        onText: (delta) => {
          if (loadingEl.parentNode) loadingEl.remove();
          if (!curTextEl) {
            curTextEl = body.createEl("div", { cls: "fyp-agent-text" });
            curStream = this.makeStreamingRenderer(curTextEl);
          }
          curText += delta;
          curStream!.schedule(curText);
        },
        onToolCall: (call) => {
          if (loadingEl.parentNode) loadingEl.remove();
          finalizeText();
          toolChips.set(call.id, this.appendToolChip(body, call.name, call.args));
          this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        },
        onToolResult: (result) => {
          const chip = toolChips.get(result.id);
          if (chip) this.setToolResult(chip, result.content);
        },
        onStatus: (status) => { this.statusEl.setText(status); },
      });
      this.statusEl.setText("");

      finalizeText();
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;

      const newMsgs = returnedMsgs.slice(sendHistory.length);
      this.store.setMessages([...this.store.active.messages, ...newMsgs]);
      await this.store.save();

    } catch (err) {
      if (loadingEl.parentNode) loadingEl.remove();
      // Roll back the user message so history stays in a consistent (alternating) state
      this.store.setMessages(this.store.active.messages.slice(0, -1));
      await this.store.save();
      assistantEl.addClass("fyp-message-error");
      body.empty();
      body.setText((err as Error).message);
      this.statusEl.setText("");
    }

    this.sending = false;
    this.inputEl.disabled = false;
    this.inputEl.focus();
    this.presetsEl.style.display = "";
  }

  private async renderMarkdown(el: HTMLElement, text: string): Promise<void> {
    el.empty();
    await MarkdownRenderer.render(this.app, text, el, "", this);
  }

  /**
   * Throttled markdown renderer for streaming text. Re-renders at most every
   * ~80ms and never overlaps two async renders, so partial markdown still shows
   * newlines and formatting as it arrives instead of one flat line.
   */
  private makeStreamingRenderer(el: HTMLElement, intervalMs = 80) {
    let latest = "";
    let dirty = false;
    let rendering = false;
    let timer: number | null = null;

    const pump = async () => {
      if (rendering) { dirty = true; return; }
      rendering = true;
      do {
        dirty = false;
        await this.renderMarkdown(el, latest);
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      } while (dirty);
      rendering = false;
    };

    return {
      schedule: (text: string) => {
        latest = text;
        if (timer != null) return;
        timer = window.setTimeout(() => { timer = null; void pump(); }, intervalMs);
      },
      flush: async (text: string) => {
        latest = text;
        if (timer != null) { window.clearTimeout(timer); timer = null; }
        await pump();
      },
    };
  }

  private formatToolArgs(args: string): string {
    try {
      return JSON.stringify(JSON.parse(args));
    } catch {
      return args;
    }
  }

  private appendToolChip(container: HTMLElement, name: string, args: string): HTMLElement {
    const details = container.createEl("details", { cls: "fyp-tool-call" });
    const summary = details.createEl("summary", { cls: "fyp-tool-summary" });
    summary.createEl("span", { cls: "fyp-tool-name", text: name.replace(/_/g, " ") });
    const formatted = this.formatToolArgs(args);
    if (formatted) summary.createEl("span", { cls: "fyp-tool-args", text: formatted });
    return details;
  }

  private setToolResult(details: HTMLElement, content: string): void {
    const pre = details.createEl("pre", { cls: "fyp-tool-result" });
    pre.setText(content.length > 2000 ? content.slice(0, 2000) + "…" : content);
  }

  private appendMessageEl(role: "user" | "assistant", text: string): HTMLElement {
    this.messagesEl.querySelector(".fyp-agent-empty")?.remove();
    const msg = this.messagesEl.createEl("div", { cls: `fyp-message fyp-message-${role}` });
    msg.createEl("span", { cls: "fyp-message-role", text: role === "user" ? "you" : "assistant" });
    msg.createEl("div", { cls: "fyp-message-content", text });
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return msg;
  }

  async onClose(): Promise<void> {}
}
