export interface ParsedRecord {
  type: "user" | "assistant";
  text: string;
  sessionId: string;
  timestamp: string;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  isToolResult?: boolean;
}

const SKIP_TYPES = new Set(["progress", "file-history-snapshot", "queue-operation", "last-prompt"]);

export function parseLine(line: string): ParsedRecord | null {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  if (!obj || !obj.type) return null;
  if (SKIP_TYPES.has(obj.type)) return null;
  if (obj.isSidechain === true) return null;
  if (obj.type !== "user" && obj.type !== "assistant") return null;

  const message = obj.message;
  if (!message) return null;

  const isToolResult = obj.type === "user" && Array.isArray(message.content)
    && message.content.some((b: any) => b.type === "tool_result");

  const text = extractTextContent(obj.type, message);
  if (!text && !isToolResult) return null;

  return {
    type: obj.type,
    text,
    sessionId: obj.sessionId || "",
    timestamp: obj.timestamp || "",
    cwd: obj.cwd,
    gitBranch: obj.gitBranch,
    model: obj.type === "assistant" ? message.model : undefined,
    isToolResult,
  };
}

export function extractTextContent(type: string, message: any): string {
  const content = message?.content;
  if (!content) return "";

  if (typeof content === "string") return content;

  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    } else if (block.type === "thinking" && block.thinking) {
      parts.push(block.thinking);
    } else if (block.type === "tool_use" && block.name) {
      parts.push(extractToolSummary(block));
    } else if (block.type === "tool_result") {
      // Exclude tool result content — it's noise for embeddings
      // (file dumps, command outputs dominate vectors and degrade relevance)
    }
  }

  return parts.join("\n\n");
}

function extractToolSummary(block: any): string {
  const name: string = block.name;
  const input: Record<string, any> = block.input || {};

  switch (name) {
    case "Write":
    case "Read":
    case "Edit":
      return `[Tool: ${name} → ${input.file_path || ""}]`;

    case "Bash": {
      const cmd = String(input.command || "").split("\n")[0].slice(0, 100);
      return `[Tool: Bash → ${cmd}]`;
    }

    case "Glob":
      return `[Tool: Glob → ${input.pattern || ""} in ${input.path || "."}]`;

    case "Grep":
      return `[Tool: Grep → "${input.pattern || ""}" in ${input.path || "."}]`;

    case "Agent":
      return `[Tool: Agent → ${input.description || input.subagent_type || ""}]`;

    default:
      return `[Tool: ${name}]`;
  }
}
