/**
 * Embeddings, with a mock that says so.
 *
 * The mock is hashed bag-of-words, not semantics. It gets lexical overlap
 * right and synonyms completely wrong, which is fine for exercising the packer
 * and the fence and useless for judging retrieval quality. Every path that
 * falls back to it says so on stderr, because a benchmark run against the mock
 * that quietly reported itself as a real number would be worse than no
 * benchmark.
 */

import { withDiskCache } from "./embed-cache.ts";
import { ledger, projectEmbeddingUsd } from "./spend.ts";
import { estimateTokens } from "./tokens.ts";

const MOCK_DIMENSIONS = 256;

export type Embedder = {
  readonly name: string;
  readonly dimensions: number;
  /** True when this is not a real model and results should not be published. */
  readonly isMock: boolean;
  embed(texts: string[]): Promise<Float32Array[]>;
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}$]+/u)
    .filter((t) => t.length > 1);
}

/** FNV-1a. Stable across runs and across machines, which Math.random is not. */
function hash(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function makeMockEmbedder(): Embedder {
  return {
    name: "mock-hashed-bow",
    dimensions: MOCK_DIMENSIONS,
    isMock: true,
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Float32Array(MOCK_DIMENSIONS);
        const tokens = tokenize(text);
        for (const token of tokens) {
          const h = hash(token);
          // Two slots per token, signed, so unrelated tokens cancel rather
          // than pile up in the same direction.
          const up = h % MOCK_DIMENSIONS;
          const down = (h >>> 8) % MOCK_DIMENSIONS;
          vector[up] = (vector[up] ?? 0) + 1;
          vector[down] = (vector[down] ?? 0) - 0.5;
        }
        normalize(vector);
        return vector;
      });
    },
  };
}

function normalize(vector: Float32Array): void {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum);
  if (length === 0) return;
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / length;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/**
 * Voyage has no official TypeScript SDK, so this is the REST endpoint.
 *
 * The timeout is not optional. `fetch` has no default one, so a stalled
 * request hangs the process with no error and no output, which is
 * indistinguishable from a slow embedding job right up until it never ends.
 */
const EMBED_TIMEOUT_MS = Number(process.env["EMBED_TIMEOUT_MS"] ?? 60_000);

export function makeVoyageEmbedder(apiKey: string, model = "voyage-3-large"): Embedder {
  return {
    name: model,
    dimensions: 1024,
    isMock: false,
    async embed(texts) {
      // Embedding is a paid call and was going through no ledger at all. The
      // module that exists because an uncapped loop emptied an account had a
      // second uncapped loop beside it, and SPEND_CAP_USD would not have
      // stopped it at any value.
      const tokens = texts.reduce((n, text) => n + estimateTokens(text), 0);
      const projected = projectEmbeddingUsd(tokens);
      ledger.authorize(projected, `embedding ${texts.length} chunks (~${tokens} tokens)`);

      const response = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: texts, input_type: "document" }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`voyage embeddings failed: ${response.status} ${await response.text()}`);
      }
      const payload = (await response.json()) as {
        data: { index: number; embedding: number[] }[];
      };
      const out = new Array<Float32Array | undefined>(texts.length);
      for (const item of payload.data) {
        out[item.index] = Float32Array.from(item.embedding);
      }
      ledger.record(projected);
      return out.map((vector, i) => {
        if (vector === undefined) throw new Error(`voyage returned no vector for input ${i}`);
        return vector;
      });
    },
  };
}

let warned = false;

/**
 * The real embedder when a key is present, the mock when it is not, and a
 * banner either way so nobody mistakes one for the other.
 */
export function resolveEmbedder(env: NodeJS.ProcessEnv = process.env): Embedder {
  const key = env["VOYAGE_API_KEY"];
  if (key !== undefined && key !== "") {
    // Cached by default. The corpus does not change between runs and a paid
    // embedding call for text already embedded is money for nothing.
    return env["EMBED_CACHE"] === "0"
      ? makeVoyageEmbedder(key)
      : withDiskCache(makeVoyageEmbedder(key));
  }

  if (env["EMBEDDINGS_STRICT"] === "1") {
    throw new Error(
      "EMBEDDINGS_STRICT=1 and VOYAGE_API_KEY is not set. Refusing to fall back to the mock.",
    );
  }

  if (!warned) {
    warned = true;
    process.stderr.write(
      [
        "",
        "  ################################################################",
        "  #  MOCK EMBEDDINGS. VOYAGE_API_KEY is not set.                 #",
        "  #  Similarity here is lexical overlap, not meaning.            #",
        "  #  Retrieval numbers from this run are not publishable.        #",
        "  #  Set EMBEDDINGS_STRICT=1 to make this an error instead.      #",
        "  ################################################################",
        "",
      ].join("\n"),
    );
  }
  return makeMockEmbedder();
}
