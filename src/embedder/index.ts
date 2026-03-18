import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { CONFIG } from "../config.js";

let extractor: FeatureExtractionPipeline | null = null;
let initPromise: Promise<FeatureExtractionPipeline> | null = null;

async function initPipeline(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;
  if (initPromise) return initPromise;

  const device = process.env.LORE_DEVICE || "auto";

  initPromise = (async () => {
    if (device === "auto") {
      // Try GPU/CoreML first, fallback to CPU if CUDA toolkit missing etc.
      try {
        const p = await pipeline("feature-extraction", CONFIG.embeddingModel, {
          dtype: "q8",
          device: "auto",
        });
        extractor = p as FeatureExtractionPipeline;
        return extractor;
      } catch (err) {
        const msg = String(err);
        if (msg.includes("libcublasLt") || msg.includes("libcudart") || msg.includes("CUDA") || msg.includes("providers_cuda")) {
          console.error("[lore] GPU unavailable (CUDA toolkit not installed?), falling back to CPU.");
        } else {
          console.error("[lore] Auto device failed, falling back to CPU:", msg.slice(0, 200));
        }
        const p = await pipeline("feature-extraction", CONFIG.embeddingModel, {
          dtype: "q8",
          device: "cpu",
        });
        extractor = p as FeatureExtractionPipeline;
        return extractor;
      }
    }

    // Explicit device from env var (cpu, cuda, coreml, etc.)
    const p = await pipeline("feature-extraction", CONFIG.embeddingModel, {
      dtype: "q8",
      device: device as any,
    });
    extractor = p as FeatureExtractionPipeline;
    return extractor;
  })();

  return initPromise;
}

export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export async function getEmbedder(): Promise<Embedder> {
  const pipe = await initPipeline();

  return {
    async embed(text: string): Promise<Float32Array> {
      const output = await pipe(text, { pooling: "mean", normalize: true });
      // tolist() returns [[...384 values...]] (shape [1, 384]), so flatten one level
      const nested = output.tolist() as number[][];
      const flat = nested[0] ?? (nested as unknown as number[]);
      return new Float32Array(flat);
    },

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      const results: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += CONFIG.indexBatchSize) {
        const batch = texts.slice(i, i + CONFIG.indexBatchSize);
        const output = await pipe(batch, { pooling: "mean", normalize: true });
        const nested = output.tolist() as number[][];
        for (const vec of nested) {
          results.push(new Float32Array(vec));
        }
      }
      return results;
    },
  };
}
