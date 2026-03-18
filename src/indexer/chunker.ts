import type { ParsedRecord } from "./parser.js";

export interface LogicalTurn {
  userText: string;
  assistantText: string;
  timestamp: string;
  turnIndex: number;
}

export interface Chunk {
  content: string;
  role: "turn";
  timestamp: string;
  turnStart: number;
  turnEnd: number;
  tokenCount: number;
}

const CJK_REGEX = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkCount = (text.match(CJK_REGEX) || []).length;
  const ratio = cjkCount / Math.max(text.length, 1);
  return ratio > 0.3 ? Math.ceil(text.length / 1.5) : Math.ceil(text.length / 4);
}

export function groupIntoLogicalTurns(records: ParsedRecord[]): LogicalTurn[] {
  // Group by logical turn boundaries:
  // - A new turn starts when type="user" AND isToolResult is NOT true
  // - tool_result user messages are part of the current turn
  const turns: LogicalTurn[] = [];
  let currentUserText = "";
  let currentAssistantText = "";
  let currentTimestamp = "";
  let turnIndex = 0;
  let inTurn = false;

  for (const rec of records) {
    if (rec.type === "user" && !rec.isToolResult) {
      // New turn boundary
      if (inTurn && (currentUserText || currentAssistantText)) {
        turns.push({
          userText: currentUserText,
          assistantText: currentAssistantText,
          timestamp: currentTimestamp,
          turnIndex,
        });
        turnIndex++;
      }
      currentUserText = rec.text;
      currentAssistantText = "";
      currentTimestamp = rec.timestamp;
      inTurn = true;
    } else if (rec.type === "assistant") {
      currentAssistantText += (currentAssistantText ? "\n\n" : "") + rec.text;
    }
    // tool_result user messages (isToolResult=true): skip, part of current turn
  }

  // Push final turn
  if (inTurn && (currentUserText || currentAssistantText)) {
    turns.push({
      userText: currentUserText,
      assistantText: currentAssistantText,
      timestamp: currentTimestamp,
      turnIndex,
    });
  }

  return turns;
}

export function chunkTurns(turns: LogicalTurn[], maxTokens = 1000, shortThreshold = 50): Chunk[] {
  const chunks: Chunk[] = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const fullText = `User: ${turn.userText}\n\nAssistant: ${turn.assistantText}`;
    const tokens = estimateTokens(fullText);

    // Merge short turns with previous chunk
    if (tokens < shortThreshold && chunks.length > 0) {
      const prev = chunks[chunks.length - 1];
      prev.content += "\n\n" + fullText;
      prev.turnEnd = turn.turnIndex;
      prev.tokenCount = estimateTokens(prev.content);
      continue;
    }

    // Split long turns
    if (tokens > maxTokens) {
      const parts = splitLongTurn(fullText, maxTokens);
      for (let j = 0; j < parts.length; j++) {
        chunks.push({
          content: parts[j],
          role: "turn",
          timestamp: turn.timestamp,
          turnStart: turn.turnIndex,
          turnEnd: turn.turnIndex,
          tokenCount: estimateTokens(parts[j]),
        });
      }
      continue;
    }

    chunks.push({
      content: fullText,
      role: "turn",
      timestamp: turn.timestamp,
      turnStart: turn.turnIndex,
      turnEnd: turn.turnIndex,
      tokenCount: tokens,
    });
  }

  return chunks;
}

function splitLongTurn(text: string, maxTokens: number): string[] {
  const paragraphs = text.split(/\n\n+/);
  const parts: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const combined = current ? current + "\n\n" + para : para;
    if (estimateTokens(combined) > maxTokens && current) {
      parts.push(current);
      current = para;
    } else {
      current = combined;
    }
  }
  if (current) parts.push(current);
  return parts;
}
