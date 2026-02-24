import { MessageRecord } from "../domain/ragTypes.js";
import { IRagStore } from "../store/interfaces.js";

const MAX_SUMMARY_CHARS = 1_200;
const RECENT_TURNS = 6;

export class ChatMemoryService {
  constructor(private readonly ragStore: IRagStore) {}

  async buildPromptContext(chatId: string): Promise<{ summary: string; recentMessages: MessageRecord[] }> {
    const summary = (await this.ragStore.getChatMemory(chatId))?.rolling_summary ?? "";
    const messages = await this.ragStore.listMessages(chatId);
    const recentMessages = messages.slice(-RECENT_TURNS);

    return {
      summary,
      recentMessages
    };
  }

  async updateRollingSummary(chatId: string): Promise<void> {
    const messages = await this.ragStore.listMessages(chatId);
    const recent = messages.slice(-RECENT_TURNS * 2);

    const summary = recent
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n")
      .slice(0, MAX_SUMMARY_CHARS);

    const lastMessageId = recent[recent.length - 1]?.id;

    await this.ragStore.updateChatMemory({
      chat_id: chatId,
      rolling_summary: summary,
      last_summarized_message_id: lastMessageId,
      updated_at: new Date().toISOString()
    });
  }
}
