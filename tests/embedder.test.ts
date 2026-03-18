import { describe, it, expect } from "vitest";
import { getEmbedder } from "../src/embedder/index.js";

describe("Embedder", () => {
  it("embeds a single text and returns 384d vector", async () => {
    const embedder = await getEmbedder();
    const result = await embedder.embed("passage: Hello world");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(384);
  }, 60000);

  it("embeds a batch of texts", async () => {
    const embedder = await getEmbedder();
    const results = await embedder.embedBatch([
      "passage: First text",
      "passage: Second text"
    ]);
    expect(results.length).toBe(2);
    expect(results[0].length).toBe(384);
    expect(results[1].length).toBe(384);
  }, 60000);

  it("produces different vectors for different semantic content", async () => {
    const embedder = await getEmbedder();
    const a = await embedder.embed("query: authentication middleware");
    const b = await embedder.embed("query: banana bread recipe");
    // Cosine similarity should be low for unrelated content
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
    }
    const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
    expect(similarity).toBeLessThan(0.8);
  }, 60000);

  it("produces similar vectors for related content", async () => {
    const embedder = await getEmbedder();
    const a = await embedder.embed("query: fix authentication bug");
    const b = await embedder.embed("query: repair auth issue");
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
    }
    const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
    expect(similarity).toBeGreaterThan(0.7);
  }, 60000);
});
