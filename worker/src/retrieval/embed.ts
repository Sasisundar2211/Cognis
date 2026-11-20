import type { Env } from "../env";

export const EMBEDDING_DIM = 384;

export interface Embedder {
  readonly model: string;
  /** Cosine floor below which a hit counts as unrelated. Model-specific. */
  readonly minSimilarity: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Cloudflare Workers AI, BAAI/bge-small-en-v1.5 (384 dims).
 * Same model family FastEmbed uses by default, so results stay comparable with the SP1 evaluation baseline.
 */
class WorkersAIEmbedder implements Embedder {
  readonly model = "@cf/baai/bge-small-en-v1.5";
  // Starting value, not yet calibrated on Cognis data. Tune with evaluation/ once real labels exist.
  readonly minSimilarity = 0.45;
  constructor(private ai: Ai) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    const out = (await this.ai.run(this.model as Parameters<Ai["run"]>[0], { text: texts } as never)) as { data?: number[][] };
    if (!out?.data || out.data.length !== texts.length) throw new Error("embedding_shape");
    return out.data.map((v) => normalize(Float32Array.from(v)));
  }
}

/**
 * Deterministic test double: hashed character trigrams. It has no semantic understanding.
 * It exists so tests exercise the semantic code path without network access.
 * Refuses to run outside APP_ENV=test.
 */
class TestHashEmbedder implements Embedder {
  readonly model = "test-hash-trigram";
  readonly minSimilarity = 0.1;
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(EMBEDDING_DIM);
      const s = ` ${t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
      for (let i = 0; i + 3 <= s.length; i++) {
        let h = 2166136261;
        for (let j = i; j < i + 3; j++) h = Math.imul(h ^ s.charCodeAt(j), 16777619);
        v[(h >>> 0) % EMBEDDING_DIM]! += 1;
      }
      return normalize(v);
    });
  }
}

export function getEmbedder(env: Env): Embedder | null {
  if (env.EMBEDDER === "workers-ai" && env.AI) return new WorkersAIEmbedder(env.AI);
  if (env.EMBEDDER === "test-hash") {
    if (env.APP_ENV !== "test") return null;
    return new TestHashEmbedder();
  }
  return null;
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

/** Cosine similarity of two L2-normalized vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i]! * b[i]!;
  return s;
}

export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function fromBlob(b: unknown): Float32Array | null {
  if (b instanceof ArrayBuffer) return new Float32Array(b.slice(0));
  if (ArrayBuffer.isView(b)) return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  if (Array.isArray(b)) return new Float32Array(Uint8Array.from(b as number[]).buffer);
  return null;
}

/** Text sent to the embedder for an item. Truncated to stay within the model's 512-token window. */
export function embeddingText(item: { title: string; description: string; content: string; extracted_text: string }): string {
  return [item.title, item.description, item.content, item.extracted_text].filter(Boolean).join("\n").slice(0, 2000);
}
