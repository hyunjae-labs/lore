import { describe, it, expect } from "vitest";
import { parseLine, extractTextContent } from "../src/indexer/parser.js";

const userLine = JSON.stringify({
  type: "user",
  message: { role: "user", content: "Fix the auth middleware" },
  sessionId: "abc-123", timestamp: "2026-03-18T07:55:11Z",
  cwd: "/Users/test/project", gitBranch: "main",
  isSidechain: false
});

const assistantLine = JSON.stringify({
  type: "assistant",
  message: {
    model: "claude-opus-4-6", role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me analyze..." },
      { type: "text", text: "Here's the fix for auth." },
      { type: "tool_use", name: "Edit", input: { file_path: "src/auth.ts" } }
    ]
  },
  sessionId: "abc-123", timestamp: "2026-03-18T07:55:20Z",
  isSidechain: false
});

describe("parseLine", () => {
  it("parses user message", () => {
    const result = parseLine(userLine);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("user");
    expect(result!.text).toBe("Fix the auth middleware");
    expect(result!.sessionId).toBe("abc-123");
  });

  it("parses assistant message with thinking + text + tool_use", () => {
    const result = parseLine(assistantLine);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("assistant");
    expect(result!.text).toContain("Let me analyze...");
    expect(result!.text).toContain("Here's the fix for auth.");
    expect(result!.text).toContain("[Tool: Edit → src/auth.ts]");
    expect(result!.model).toBe("claude-opus-4-6");
  });

  it("skips progress records", () => {
    const line = JSON.stringify({ type: "progress", data: {} });
    expect(parseLine(line)).toBeNull();
  });

  it("skips sidechain records", () => {
    const line = JSON.stringify({ ...JSON.parse(userLine), isSidechain: true });
    expect(parseLine(line)).toBeNull();
  });

  it("skips malformed lines gracefully", () => {
    expect(parseLine("not json")).toBeNull();
    expect(parseLine("{}")).toBeNull();
  });

  it("detects tool_result user messages", () => {
    const toolResultLine = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "123", content: "result" }] },
      sessionId: "abc-123", timestamp: "2026-03-18T07:55:15Z"
    });
    const result = parseLine(toolResultLine);
    expect(result).not.toBeNull();
    expect(result!.isToolResult).toBe(true);
  });

  it("handles empty thinking blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-6", role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "abc123" },
          { type: "text", text: "Response without thinking." }
        ]
      },
      sessionId: "abc-123", timestamp: "2026-03-18T07:55:20Z"
    });
    const result = parseLine(line);
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Response without thinking.");
    // empty thinking block should not inject any extra content beyond the text block
    expect(result!.text).not.toContain("[Thinking]");
    expect(result!.text).not.toContain("\n\n");
  });

  it("skips file-history-snapshot, queue-operation, last-prompt", () => {
    expect(parseLine(JSON.stringify({ type: "file-history-snapshot", snapshot: {} }))).toBeNull();
    expect(parseLine(JSON.stringify({ type: "queue-operation", data: {} }))).toBeNull();
    expect(parseLine(JSON.stringify({ type: "last-prompt", message: {} }))).toBeNull();
  });
});
