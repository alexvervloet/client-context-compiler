/**
 * Everything here imports from the package entry point only, and none of it
 * touches the bundled firm. If this file needs a deep import to work, the
 * public surface has a hole in it.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildChunk,
  buildMentionIndex,
  extractCitations,
  makeCompiler,
  makeMockEmbedder,
  newSession,
  recordTurn,
  refKey,
} from "../src/index.ts";
import type { Chunk, Directory } from "../src/index.ts";

const NOW = "2026-08-27T09:00:00Z";

/** A different firm entirely: two clients, one advisor, four records. */
const directory: Directory = {
  clients: [
    {
      id: "c_ash",
      first: "Priya",
      last: "Ashworth",
      email: "priya.ashworth@client.test",
      advisorId: "a_one",
    },
    {
      id: "c_bram",
      first: "Tomas",
      last: "Bramley",
      email: "tomas.bramley@client.test",
      advisorId: "a_one",
    },
  ],
};

const index = buildMentionIndex(directory.clients);

function chunk(
  id: string,
  text: string,
  owners: string[],
  layer: Chunk["layer"] = "client",
): Chunk {
  return buildChunk(
    id,
    layer,
    text,
    { system: "crm", kind: "record", id, label: `record ${id}` },
    "2026-08-01T00:00:00.000Z",
    index,
    owners,
  );
}

const chunks: Chunk[] = [
  chunk("r1", "Priya Ashworth is selling the Kelburn warehouse in October.", ["c_ash"]),
  chunk("r2", "Tomas Bramley has a balloon payment due in November.", ["c_bram"]),
  // Named for nobody in particular; only the owner field says whose it is.
  chunk("r3", "Client asked us to hold the rebalance until the sale settles.", ["c_ash"]),
  chunk("r4", "The firm does not add commercial exposure at current cap rates.", [], "firm"),
];

const compiler = await makeCompiler({
  chunks,
  directory,
  embedder: makeMockEmbedder(),
});

test("a caller's own chunks and directory compile without the bundled firm", async () => {
  const out = await compiler.compile({
    task: "meeting-prep",
    clientId: "c_ash",
    advisorId: "a_one",
    budgetTokens: 4000,
    now: NOW,
  });

  assert.ok(out.text.includes("Kelburn warehouse"));
  assert.ok(out.text.includes("hold the rebalance"), "an owner-only record should be admitted");
  assert.ok(out.text.includes("cap rates"), "firm knowledge serves everyone");
  assert.ok(!out.text.includes("Bramley"));
  assert.ok(!out.text.includes("balloon payment"));
});

test("the fence works on a directory it has never seen before", async () => {
  const out = await compiler.compile({
    task: "meeting-prep",
    clientId: "c_bram",
    advisorId: "a_one",
    budgetTokens: 4000,
    now: NOW,
  });
  assert.ok(!out.text.includes("Ashworth"));
  assert.ok(!out.text.includes("Kelburn"));
  assert.ok(!out.text.includes("hold the rebalance"));
});

test("citation keys round-trip through the public helpers", async () => {
  const out = await compiler.compile({
    task: "meeting-prep",
    clientId: "c_ash",
    advisorId: "a_one",
    budgetTokens: 4000,
    now: NOW,
  });

  const real = [...out.citable.keys()][0];
  assert.ok(real !== undefined);
  const { cited, fabricated } = extractCitations(
    `She is selling in October [${real}]. She also owns a yacht [crm:record/nope].`,
    out,
  );
  assert.deepEqual(cited, [real]);
  assert.deepEqual(fabricated, ["crm:record/nope"]);
  assert.equal(refKey(out.citable.get(real)!), real);
});

test("sessions fence against a caller's own directory", async () => {
  let session = newSession("s1", "a_one");
  session = recordTurn(session, {
    id: "turn1",
    role: "assistant",
    text: "The balloon payment lands in November and there is no sinking fund.",
    clientId: "c_bram",
    at: "2026-08-27T08:30:00Z",
  });

  const out = await compiler.compile(
    {
      task: "meeting-prep",
      clientId: "c_ash",
      advisorId: "a_one",
      budgetTokens: 4000,
      now: NOW,
    },
    session,
  );
  assert.equal(out.manifest.layers.conversation.admitted, 0);
  assert.ok(!out.text.includes("balloon payment"));
});
