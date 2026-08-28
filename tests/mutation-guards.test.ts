/**
 * Contracts that nothing else was pinning.
 *
 * An independent audit ran fourteen single-line mutations against this
 * repository. Ten survived the full 290-check eval suite, and five survived
 * the unit tests as well: the client pre-filter could be deleted outright, the
 * unanchored refusal removed, the fence policy forced to `redact`, and the
 * redaction mask set to the empty string, with everything still green.
 *
 * The diagnosis was that the suite tested the corpus rather than the code. A
 * corpus-driven test only reaches a branch the bundled data happens to enter,
 * and every one of those five branches is reachable through the public API by
 * a caller supplying their own chunks. These tests call the units directly and
 * assert their contracts, so removing a mechanism fails here even when no
 * bundled window changes.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildIndex, search, servesSubject } from "../src/retrieve.ts";
import { buildChunk } from "../src/normalize.ts";
import { buildMentionIndex } from "../src/mentions.ts";
import { makeMockEmbedder } from "../src/embed.ts";
import { fence, MASK } from "../src/fence.ts";
import type { Chunk, DirectoryEntry } from "../src/types.ts";

const clients: DirectoryEntry[] = [
  { id: "c_a", first: "Anna", last: "Ashford", email: "anna@x.test", advisorId: "adv" },
  { id: "c_b", first: "Bruno", last: "Ashford", email: "bruno@x.test", advisorId: "adv" },
  { id: "c_c", first: "Carla", last: "Reyes", email: "carla@x.test", advisorId: "adv" },
];
const index = buildMentionIndex(clients);
const AUTHORIZED = new Set(["c_a", "c_b", "c_c"]);

function chunk(id: string, text: string, owners: string[], layer: Chunk["layer"] = "client"): Chunk {
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

// ------------------------------------------- the client pre-filter in retrieval

test("retrieval never returns a record owned by somebody else", async () => {
  const chunks = [
    chunk("a1", "Anna Ashford is selling the warehouse in October.", ["c_a"]),
    chunk("b1", "Bruno Ashford has a balloon payment due in November.", ["c_b"]),
    chunk("c1", "Carla Reyes wants the allocation left alone.", ["c_c"]),
    // Owned by Bruno, names Anna. A pre-filter reading `clients` rather than
    // `owners` will hand this to Anna.
    chunk("b2", "For Anna Ashford: Bruno's balance is now $2.4M.", ["c_b"]),
  ];
  const built = await buildIndex(chunks, makeMockEmbedder());

  for (const subject of ["c_a", "c_b", "c_c"]) {
    const results = await search(built, {
      query: "anything at all",
      subject,
      now: "2026-08-27T09:00:00Z",
    });
    for (const candidate of results) {
      assert.ok(
        candidate.chunk.owners.includes(subject),
        `search for ${subject} returned ${candidate.chunk.id}, owned by ` +
          `${candidate.chunk.owners.join("/")}. The pre-filter is not filtering.`,
      );
    }
  }
});

test("servesSubject rejects a record whose owners exclude the subject", () => {
  const other = chunk("b1", "Bruno Ashford has a balloon payment.", ["c_b"]);
  assert.equal(servesSubject(other, "c_a"), false);
  assert.equal(servesSubject(other, "c_b"), true);
});

test("owners decide eligibility even when the text names the subject", () => {
  // Bruno's record, whose prose names Anna. `clients` is the union of owners
  // and everyone mentioned, so it contains Anna and a filter that consults
  // only `clients` lets this through. It is Bruno's record and it carries
  // Bruno's balance.
  const bruno = chunk("b2", "For Anna Ashford: Bruno's balance is now $2.4M.", ["c_b"]);
  assert.ok(bruno.clients.includes("c_a"), "the mention should be detected");
  assert.equal(bruno.owners.includes("c_a"), false);
  assert.equal(
    servesSubject(bruno, "c_a"),
    false,
    "eligibility follows the record's owner, not a name in its prose",
  );
});

test("firm knowledge serves everyone and client records do not", () => {
  const firm = chunk("f1", "The firm does not add exposure at current cap rates.", [], "firm");
  assert.equal(servesSubject(firm, "c_a"), true);
  assert.equal(servesSubject(firm, "c_c"), true);
});

// ------------------------------------------------------ the unanchored refusal

test("a chunk with no owner and only an ambiguous name is refused, not admitted", () => {
  // "Ashford" could be Anna or Bruno, nothing else names anyone, and no
  // connector told us whose record it is. Admitting it would file one
  // sibling's balance under the other. Reachable through the public API by any
  // caller whose source system does not carry ownership.
  const orphan = chunk("o1", "Ashford — meeting notes. Balance is now $2.4M.", []);
  const verdict = fence(orphan, { subject: "c_a", authorized: AUTHORIZED, index });
  assert.equal(verdict.action, "refuse");
  assert.ok(verdict.action === "refuse" && verdict.reason === "unanchored");
});

test("the same chunk is admitted once a connector says whose it is", () => {
  const owned = chunk("o2", "Ashford — meeting notes. Balance is now $2.4M.", ["c_a"]);
  const verdict = fence(owned, { subject: "c_a", authorized: AUTHORIZED, index });
  assert.equal(verdict.action, "admit");
});

// ------------------------------------------------------------- the two policies

test("strict and redact reach different verdicts on the same chunk", () => {
  // Anna's own record, mentioning Carla in passing. Strict refuses the whole
  // passage; redact keeps it with the name masked. A build where both policies
  // behave identically has lost one of them.
  const incidental = chunk(
    "i1",
    "Anna Ashford is using the same structure Carla Reyes used last year.",
    ["c_a"],
  );
  const strict = fence(incidental, { subject: "c_a", authorized: AUTHORIZED, index });
  const lenient = fence(incidental, {
    subject: "c_a",
    authorized: AUTHORIZED,
    index,
    policy: "redact",
  });

  assert.equal(strict.action, "refuse");
  assert.equal(lenient.action, "redact");
  assert.notEqual(strict.action, lenient.action);
});

test("the mask is visible in the text, not a silent deletion", () => {
  assert.ok(MASK.trim().length > 0, "an empty mask deletes a name without saying so");

  const incidental = chunk(
    "i2",
    "Anna Ashford is using the same structure Carla Reyes used last year.",
    ["c_a"],
  );
  const verdict = fence(incidental, {
    subject: "c_a",
    authorized: AUTHORIZED,
    index,
    policy: "redact",
  });

  assert.ok(verdict.action === "redact");
  assert.ok(verdict.text.includes(MASK), "the redacted passage must show where a name was removed");
  assert.ok(!verdict.text.includes("Carla"));
  assert.ok(verdict.text.includes("Anna Ashford"), "the subject's own name must survive");
});
