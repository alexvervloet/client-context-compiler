/**
 * Retrieval, with the client filter applied before scoring rather than after.
 *
 * Filtering after ranking is the common shape and it is wrong in two ways.
 * It leaks through top-k: ask for twenty candidates, discard eleven that
 * belong to other clients, and the window is built from nine. And it means a
 * forbidden chunk was ranked, logged, and traced before anyone checked whether
 * it was allowed to exist in that request. Chunks that cannot serve the
 * subject never enter the comparison here.
 *
 * Recency is blended into the score rather than used as a tiebreak, because
 * the stale-note trap is not a tie. A 2024 note saying a client is aggressive
 * and a 2026 note saying she is conservative are both an excellent lexical
 * match for "risk tolerance", and the wrong one wins on similarity alone.
 */

import type { Chunk, ClientId } from "./types.ts";
import { cosine } from "./embed.ts";
import type { Embedder } from "./embed.ts";

const EMBED_BATCH = 96;

export type SearchIndex = {
  chunks: Chunk[];
  vectors: Float32Array[];
  embedder: Embedder;
};

export type IndexProgress = (done: number, total: number) => void;

export async function buildIndex(
  chunks: Chunk[],
  embedder: Embedder,
  onProgress?: IndexProgress,
): Promise<SearchIndex> {
  const vectors: Float32Array[] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    vectors.push(...(await embedder.embed(batch.map((c) => c.text))));
    onProgress?.(vectors.length, chunks.length);
  }
  return { chunks, vectors, embedder };
}

export type Candidate = {
  chunk: Chunk;
  similarity: number;
  /** 1 for something written today, decaying with age. */
  recency: number;
  score: number;
};

export type SearchOptions = {
  query: string;
  subject: ClientId;
  /** ISO. Fixed clock so a search is reproducible. */
  now: string;
  topK?: number;
  /** How much of the score is recency rather than similarity. */
  recencyWeight?: number;
  /** Age at which a record has half the recency score of a new one. */
  halfLifeDays?: number;
  /**
   * Floor, as a fraction of the best similarity in this search rather than an
   * absolute cosine. A raw threshold does not survive changing embedding
   * model: the mock here scores in a different range than Voyage does, and a
   * number tuned against one silently empties windows under the other.
   */
  relativeFloor?: number;
};

const DEFAULTS = {
  topK: 40,
  recencyWeight: 0.35,
  halfLifeDays: 180,
  relativeFloor: 0.15,
};

export type SearchResult = {
  candidates: Candidate[];
  /**
   * Eligible chunks that lost to `topK` or the relevance floor.
   *
   * Returned rather than discarded so the manifest can account for them. A
   * manifest that only lists what survived retrieval is not the complete
   * record of a decision, it is the record of the decisions made after the
   * interesting one.
   */
  dropped: Array<{ chunk: Chunk; score: number; detail: string }>;
};

export async function search(
  index: SearchIndex,
  options: SearchOptions,
): Promise<SearchResult> {
  const topK = options.topK ?? DEFAULTS.topK;
  const recencyWeight = options.recencyWeight ?? DEFAULTS.recencyWeight;
  const halfLifeDays = options.halfLifeDays ?? DEFAULTS.halfLifeDays;
  const relativeFloor = options.relativeFloor ?? DEFAULTS.relativeFloor;

  const [queryVector] = await index.embedder.embed([options.query]);
  if (queryVector === undefined) throw new Error("embedder returned no query vector");

  const nowMs = Date.parse(options.now);
  const scored: Candidate[] = [];
  let best = 0;

  for (let i = 0; i < index.chunks.length; i++) {
    const chunk = index.chunks[i];
    const vector = index.vectors[i];
    if (chunk === undefined || vector === undefined) continue;

    // The filter, before the comparison.
    if (!servesSubject(chunk, options.subject)) continue;

    const similarity = cosine(queryVector, vector);
    if (similarity > best) best = similarity;

    const ageDays = Math.max(0, (nowMs - Date.parse(chunk.timestamp)) / 86_400_000);
    const recency = Math.pow(0.5, ageDays / halfLifeDays);
    scored.push({
      chunk,
      similarity,
      recency,
      score: similarity * (1 - recencyWeight) + recency * recencyWeight,
    });
  }

  // The floor exists to stop a long tail of weak matches eating the budget.
  // With no tail there is nothing to trim, and trimming anyway is how a client
  // with a thin file ends up with an empty window. Relative to this search's
  // own best match, because an absolute cosine does not survive a change of
  // embedding model.
  const applyFloor = scored.length > topK && best > 0;
  const floor = best * relativeFloor;
  const dropped: SearchResult["dropped"] = [];

  const abovefloor = scored.filter((c) => {
    if (!applyFloor || c.similarity >= floor) return true;
    dropped.push({
      chunk: c.chunk,
      score: c.score,
      detail: `similarity ${c.similarity.toFixed(3)} is below ${(relativeFloor * 100).toFixed(0)}% of the best match (${best.toFixed(3)})`,
    });
    return false;
  });

  abovefloor.sort((a, b) => b.score - a.score);
  for (const [rank, candidate] of abovefloor.slice(topK).entries()) {
    dropped.push({
      chunk: candidate.chunk,
      score: candidate.score,
      detail: `ranked ${topK + rank + 1} of ${abovefloor.length}, past a topK of ${topK}`,
    });
  }

  return { candidates: abovefloor.slice(0, topK), dropped };
}

/**
 * Whether a chunk could serve this client at all. Firm knowledge serves
 * everyone; client text has to name the subject somewhere. A chunk that names
 * only other people is not a low-scoring candidate, it is not a candidate.
 */
export function servesSubject(chunk: Chunk, subject: ClientId): boolean {
  if (chunk.layer === "firm" && chunk.clients.length === 0) return true;
  // A record owned by somebody else is not a weak candidate, it is not one.
  if (chunk.owners.length > 0 && !chunk.owners.includes(subject)) return false;
  return chunk.clients.includes(subject);
}
