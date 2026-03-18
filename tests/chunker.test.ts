import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  groupIntoLogicalTurns,
  chunkTurns,
} from "../src/indexer/chunker.js";
import type { ParsedRecord } from "../src/indexer/parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(text: string, timestamp = "2026-03-18T08:00:00Z", isToolResult = false): ParsedRecord {
  return { type: "user", text, sessionId: "s1", timestamp, isToolResult };
}

function makeAssistant(text: string, timestamp = "2026-03-18T08:00:10Z"): ParsedRecord {
  return { type: "assistant", text, sessionId: "s1", timestamp };
}

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("estimates Latin text at roughly chars/4", () => {
    const text = "a".repeat(400); // 400 Latin chars → ~100 tokens
    const tokens = estimateTokens(text);
    expect(tokens).toBe(100);
  });

  it("estimates Korean text at roughly chars/1.5", () => {
    // Korean characters are in U+AC00–U+D7AF range
    const text = "안".repeat(150); // 150 Korean chars → ceil(150/1.5) = 100 tokens
    const tokens = estimateTokens(text);
    expect(tokens).toBe(100);
  });

  it("estimates mixed text based on CJK ratio", () => {
    // 50% CJK → ratio=0.5 > 0.3 → use chars/1.5
    const cjk = "한".repeat(50);
    const latin = "a".repeat(50);
    const text = cjk + latin; // 100 chars total, 50% CJK → ceil(100/1.5) = 67
    const tokens = estimateTokens(text);
    expect(tokens).toBe(67);
  });

  it("handles empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("uses Latin formula when CJK ratio is below 0.3", () => {
    // 20% CJK → ratio < 0.3 → use chars/4
    const cjk = "한".repeat(20);
    const latin = "a".repeat(80);
    const text = cjk + latin; // 100 chars, 20% CJK → ceil(100/4) = 25
    const tokens = estimateTokens(text);
    expect(tokens).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// groupIntoLogicalTurns
// ---------------------------------------------------------------------------

describe("groupIntoLogicalTurns", () => {
  it("returns empty array for empty input", () => {
    expect(groupIntoLogicalTurns([])).toEqual([]);
  });

  it("groups a simple 2-turn conversation", () => {
    const records: ParsedRecord[] = [
      makeUser("Fix the auth bug", "2026-03-18T08:00:00Z"),
      makeAssistant("Done.", "2026-03-18T08:00:10Z"),
      makeUser("Now add tests", "2026-03-18T08:01:00Z"),
      makeAssistant("Added tests.", "2026-03-18T08:01:10Z"),
    ];

    const turns = groupIntoLogicalTurns(records);

    expect(turns).toHaveLength(2);

    expect(turns[0].userText).toBe("Fix the auth bug");
    expect(turns[0].assistantText).toBe("Done.");
    expect(turns[0].timestamp).toBe("2026-03-18T08:00:00Z");
    expect(turns[0].turnIndex).toBe(0);

    expect(turns[1].userText).toBe("Now add tests");
    expect(turns[1].assistantText).toBe("Added tests.");
    expect(turns[1].timestamp).toBe("2026-03-18T08:01:00Z");
    expect(turns[1].turnIndex).toBe(1);
  });

  it("groups a multi-step tool-use chain into a single turn", () => {
    // user: "Fix bug"  → turn starts
    //   assistant: [tool_use: Read]
    //   user: [tool_result]          ← NOT a new turn
    //   assistant: [tool_use: Edit]
    //   user: [tool_result]          ← NOT a new turn
    //   assistant: "Done"            ← turn ends
    // user: "Now add tests"          ← next turn starts
    const records: ParsedRecord[] = [
      makeUser("Fix the auth bug", "2026-03-18T08:00:00Z"),
      makeAssistant("[Tool: Read src/auth.ts]", "2026-03-18T08:00:05Z"),
      makeUser("[tool result content]", "2026-03-18T08:00:06Z", true),
      makeAssistant("[Tool: Edit src/auth.ts]", "2026-03-18T08:00:07Z"),
      makeUser("[tool result content]", "2026-03-18T08:00:08Z", true),
      makeAssistant("Done, fixed the auth bug.", "2026-03-18T08:00:09Z"),
      makeUser("Now add tests", "2026-03-18T08:01:00Z"),
      makeAssistant("Added tests.", "2026-03-18T08:01:10Z"),
    ];

    const turns = groupIntoLogicalTurns(records);

    expect(turns).toHaveLength(2);

    // First turn should contain all three assistant messages joined
    expect(turns[0].userText).toBe("Fix the auth bug");
    expect(turns[0].assistantText).toContain("[Tool: Read src/auth.ts]");
    expect(turns[0].assistantText).toContain("[Tool: Edit src/auth.ts]");
    expect(turns[0].assistantText).toContain("Done, fixed the auth bug.");
    expect(turns[0].turnIndex).toBe(0);

    expect(turns[1].userText).toBe("Now add tests");
    expect(turns[1].turnIndex).toBe(1);
  });

  it("handles records with only a user message (no assistant reply yet)", () => {
    const records: ParsedRecord[] = [
      makeUser("What is the capital of France?", "2026-03-18T08:00:00Z"),
    ];
    const turns = groupIntoLogicalTurns(records);
    expect(turns).toHaveLength(1);
    expect(turns[0].userText).toBe("What is the capital of France?");
    expect(turns[0].assistantText).toBe("");
  });

  it("assigns sequential turnIndex values", () => {
    const records: ParsedRecord[] = [
      makeUser("Turn 0", "T0"),
      makeAssistant("Reply 0", "T0"),
      makeUser("Turn 1", "T1"),
      makeAssistant("Reply 1", "T1"),
      makeUser("Turn 2", "T2"),
      makeAssistant("Reply 2", "T2"),
    ];
    const turns = groupIntoLogicalTurns(records);
    expect(turns.map((t) => t.turnIndex)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// chunkTurns
// ---------------------------------------------------------------------------

describe("chunkTurns", () => {
  it("produces one chunk per normal turn", () => {
    const turns = groupIntoLogicalTurns([
      makeUser("What is TypeScript?", "T1"),
      makeAssistant("TypeScript is a typed superset of JavaScript.", "T1"),
      makeUser("What is a tuple?", "T2"),
      makeAssistant("A tuple is a fixed-length array.", "T2"),
    ]);

    // Both turns are well within defaults (not short, not long)
    // estimateTokens("User: What is TypeScript?\n\nAssistant: TypeScript is a typed superset of JavaScript.")
    // = ceil(~80 chars / 4) = 20 tokens → short (<50), will merge with prev
    // We need longer text to avoid the merge. Use maxTokens=1000, shortThreshold=10 to test normal.
    const chunks = chunkTurns(turns, 1000, 10);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].role).toBe("turn");
    expect(chunks[0].turnStart).toBe(0);
    expect(chunks[0].turnEnd).toBe(0);
  });

  it("first chunk has no overlap prefix", () => {
    const turns = groupIntoLogicalTurns([
      makeUser("Hello", "T1"),
      makeAssistant("Hi there, how can I help you today with your project?", "T1"),
      makeUser("Tell me about TypeScript", "T2"),
      makeAssistant("TypeScript is great.", "T2"),
    ]);

    const chunks = chunkTurns(turns, 1000, 10);
    // First chunk should not contain the separator "---"
    expect(chunks[0].content).not.toContain("---");
  });

  it("chunks do not contain overlap prefix (clean for embedding)", () => {
    const turns = groupIntoLogicalTurns([
      makeUser("Hello there", "T1"),
      makeAssistant("Hi, how can I help you today with your project work?", "T1"),
      makeUser("Tell me about TypeScript interfaces", "T2"),
      makeAssistant("TypeScript interfaces define contracts.", "T2"),
    ]);

    const chunks = chunkTurns(turns, 1000, 10);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // No chunk should contain overlap separator — clean content for embedding
    for (const chunk of chunks) {
      expect(chunk.content).not.toContain("---\n\n");
    }
  });

  it("merges short turns (<shortThreshold tokens) with the previous chunk", () => {
    const records: ParsedRecord[] = [
      makeUser("Hello", "T1"),
      makeAssistant("Hi!", "T1"),
      // This second turn is very short
      makeUser("Ok", "T2"),
      makeAssistant("Sure.", "T2"),
    ];
    const turns = groupIntoLogicalTurns(records);

    // With shortThreshold=50, both turns are short.
    // First turn: no previous chunk, so it gets its own chunk (even if short).
    // Second turn: tokens < 50 → merges into first chunk.
    const chunks = chunkTurns(turns, 1000, 50);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("Hello");
    expect(chunks[0].content).toContain("Ok");
    expect(chunks[0].turnEnd).toBe(1);
  });

  it("splits long turns into multiple chunks at paragraph boundaries", () => {
    // Create a turn whose combined text exceeds maxTokens=50
    // Each paragraph ~60 chars = 15 tokens. We want total > 50.
    const para1 = "a".repeat(60); // 15 tokens
    const para2 = "b".repeat(60); // 15 tokens
    const para3 = "c".repeat(60); // 15 tokens
    const para4 = "d".repeat(60); // 15 tokens

    const longAssistantText = [para1, para2, para3, para4].join("\n\n");

    const turns = groupIntoLogicalTurns([
      makeUser("Explain everything", "T1"),
      makeAssistant(longAssistantText, "T1"),
    ]);

    // maxTokens=50 means fullText (User:...\n\nAssistant:...) >50 tokens → split
    const chunks = chunkTurns(turns, 50, 5);
    expect(chunks.length).toBeGreaterThan(1);
    // All chunks should have turnStart=0 and turnEnd=0
    for (const chunk of chunks) {
      expect(chunk.turnStart).toBe(0);
      expect(chunk.turnEnd).toBe(0);
      expect(chunk.role).toBe("turn");
    }
  });

  it("each chunk has a positive tokenCount", () => {
    const turns = groupIntoLogicalTurns([
      makeUser("Question one here", "T1"),
      makeAssistant("Answer one here.", "T1"),
    ]);
    const chunks = chunkTurns(turns, 1000, 5);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeGreaterThan(0);
    }
  });

  it("returns empty array for empty turns", () => {
    expect(chunkTurns([])).toEqual([]);
  });

  it("chunk content contains both user and assistant text for a normal turn", () => {
    const turns = groupIntoLogicalTurns([
      makeUser("What is recursion?", "T1"),
      makeAssistant("Recursion is when a function calls itself.", "T1"),
    ]);
    const chunks = chunkTurns(turns, 1000, 5);
    expect(chunks[0].content).toContain("What is recursion?");
    expect(chunks[0].content).toContain("Recursion is when a function calls itself.");
  });
});
