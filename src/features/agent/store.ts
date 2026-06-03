import type { AgentMessage } from "../../core/llm";
import type FypPlugin from "../../main";

export interface Conversation {
  id: string;
  created: number;
  messages: AgentMessage[];
}

export class ConversationStore {
  private conversations: Conversation[];
  private activeIdx: number;
  private plugin: FypPlugin;

  constructor(plugin: FypPlugin) {
    this.plugin = plugin;
    const persisted = plugin.getAgentConversations() as Conversation[];
    if (persisted.length > 0) {
      this.conversations = persisted;
      this.activeIdx = persisted.length - 1;
    } else {
      this.conversations = [{ id: "initial", created: Date.now(), messages: [] }];
      this.activeIdx = 0;
    }
  }

  get active(): Conversation {
    return this.conversations[this.activeIdx];
  }

  get activeIndex(): number {
    return this.activeIdx;
  }

  get all(): Conversation[] {
    return this.conversations;
  }

  async newConversation(): Promise<boolean> {
    if (this.active.messages.length === 0) return false;
    const conv: Conversation = { id: Date.now().toString(), created: Date.now(), messages: [] };
    this.conversations.push(conv);
    this.activeIdx = this.conversations.length - 1;
    await this.save();
    return true;
  }

  switchTo(idx: number): void {
    this.activeIdx = idx;
  }

  async save(): Promise<void> {
    await this.plugin.saveAgentConversations(this.conversations);
  }

  setMessages(msgs: AgentMessage[]): void {
    this.active.messages = msgs;
  }
}
