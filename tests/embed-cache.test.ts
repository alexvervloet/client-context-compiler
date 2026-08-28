/**
 * The cache exists because the same 787 chunks were being embedded from
 * scratch on every run, including dry runs that then reported spending
 * nothing. These assert it actually prevents the second call.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDiskCache } from "../src/embed-cache.ts";
import { makeMockEmbedder } from "../src/embed.ts";
import type { Embedder } from "../src/embed.ts";

/** A paid embedder stand-in that counts how many texts it was asked to embed. */
function countingEmbedder(): Embedder & { embedded: string[] } {
  const embedded: string[] = [];
  return {
    name: "counting-fake",
    dimensions: 4,
    isMock: false,
    embedded,
    async embed(texts) {
      embedded.push(...texts);
      return texts.map((t) => Float32Array.from([t.length, 1, 0, 0]));
    },
  };
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ccc-cache-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the same text is embedded once, not twice", async () => {
  await withTempDir(async (dir) => {
    const inner = countingEmbedder();
    const cached = withDiskCache(inner, { dir });

    await cached.embed(["alpha", "beta"]);
    await cached.embed(["alpha", "beta"]);

    assert.deepEqual(inner.embedded, ["alpha", "beta"], "the second call should be free");
  });
});

test("only the new text in a batch reaches the paid embedder", async () => {
  await withTempDir(async (dir) => {
    const inner = countingEmbedder();
    const cached = withDiskCache(inner, { dir });

    await cached.embed(["alpha"]);
    await cached.embed(["alpha", "gamma"]);

    assert.deepEqual(inner.embedded, ["alpha", "gamma"]);
  });
});

test("cached vectors come back in the order they were asked for", async () => {
  await withTempDir(async (dir) => {
    const cached = withDiskCache(countingEmbedder(), { dir });
    await cached.embed(["aa", "bbbb"]);
    const again = await cached.embed(["bbbb", "aa"]);
    // The fake encodes length in the first slot, so order is checkable.
    assert.equal(again[0]?.[0], 4);
    assert.equal(again[1]?.[0], 2);
  });
});

test("a different model does not read another model's vectors", async () => {
  await withTempDir(async (dir) => {
    const first = countingEmbedder();
    await withDiskCache(first, { dir }).embed(["alpha"]);

    const second = countingEmbedder();
    const renamed: Embedder = { ...second, name: "a-different-model" };
    await withDiskCache(renamed, { dir }).embed(["alpha"]);

    assert.deepEqual(second.embedded, ["alpha"], "a model change must miss");
  });
});

test("the mock is not cached, so a change to it cannot serve stale vectors", () => {
  const mock = makeMockEmbedder();
  assert.equal(withDiskCache(mock), mock);
});
