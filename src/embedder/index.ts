import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { CONFIG } from "../config.js";

let extractor: FeatureExtractionPipeline | null = null;
let initPromise: Promise<FeatureExtractionPipeline> | null = null;

async function initPipeline(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;
  if (initPromise) return initPromise;

  initPromise = pipeline("feature-extraction", CONFIG.embeddingModel, {
    dtype: "q8",              // INT8 quantized — 1.5x faster, ~112MB vs 448MB
    device: "auto",           // Use GPU/CoreML/WebGPU if available, fallback to CPU
  }).then((p) => {
    extractor = p as FeatureExtractionPipeline;
    return extractor;
  });

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
