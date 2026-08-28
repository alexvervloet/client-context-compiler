/**
 * Embeddings, remembered.
 *
 * The corpus is deterministic from a seed and the same 787 chunks were being
 * embedded from scratch on every single run of the evals, the measurement
 * script and the bench, dry runs included. Nine or so identical passes through
 * a paid embedding API, for a corpus that had not changed once.
 *
 * Keyed by model name and content hash, so changing the embedding model or
 * editing a chunk both miss correctly. Stored under out/, which is gitignored:
 * a cache is not a build artifact anyone should be reviewing.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Embedder } from "./embed.ts";

const DEFAULT_DIR = "out/embed-cache";

function keyFor(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

type CacheFile = Record<string, number[]>;

function load(path: string): CacheFile {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CacheFile;
  } catch {
    // A missing or corrupt cache is a cache miss, not an error. Re-embedding
    // costs money but returning wrong vectors costs correctness.
    return {};
  }
}

export type CacheStats = { hits: number; misses: number };

/**
 * Wrap an embedder so identical text is embedded once.
 *
 * Writes on process exit rather than per batch, so a run that dies halfway
 * still keeps what it paid for.
 */
export function withDiskCache(
  embedder: Embedder,
  options: { dir?: string; onStats?: (stats: CacheStats) => void } = {},
): Embedder {
  // The mock costs nothing and caching it only risks serving stale vectors
  // from a previous implementation of it.
  if (embedder.isMock) return embedder;

  const path = join(options.dir ?? DEFAULT_DIR, `${embedder.name.replace(/[^\w.-]/g, "_")}.json`);
  const cache = load(path);
  const stats: CacheStats = { hits: 0, misses: 0 };
  let dirty = false;

  const flush = (): void => {
    if (!dirty) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(cache));
      dirty = false;
    } catch {
      // A cache that cannot be written is still a working embedder.
    }
  };

  process.once("exit", flush);

  return {
    name: embedder.name,
    dimensions: embedder.dimensions,
    isMock: false,
    async embed(texts) {
      const out: Array<Float32Array | undefined> = new Array(texts.length);
      const missing: number[] = [];

      for (const [i, text] of texts.entries()) {
        const hit = cache[keyFor(text)];
        if (hit === undefined) {
          missing.push(i);
        } else {
          out[i] = Float32Array.from(hit);
          stats.hits++;
        }
      }

      if (missing.length > 0) {
        stats.misses += missing.length;
        const fresh = await embedder.embed(missing.map((i) => texts[i] ?? ""));
        for (const [j, i] of missing.entries()) {
          const vector = fresh[j];
          if (vector === undefined) throw new Error(`embedder returned no vector for input ${i}`);
          out[i] = vector;
          cache[keyFor(texts[i] ?? "")] = Array.from(vector);
          dirty = true;
        }
        flush();
      }

      options.onStats?.(stats);
      return out.map((vector, i) => {
        if (vector === undefined) throw new Error(`no vector for input ${i}`);
        return vector;
      });
    },
  };
}
