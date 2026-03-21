// Shared MCP tool response helpers

export function toolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

export function toolError(message: string) {
  return toolResult({ error: message });
}
