import { strict as assert } from "node:assert";
import { test } from "node:test";
import { generateCorpus } from "../src/corpus/generate.ts";
import { normalize } from "../src/normalize.ts";
import { buildMentionIndex } from "../src/mentions.ts";
import { assertSingleClient, fence, MASK } from "../src/fence.ts";
import type { Chunk } from "../src/types.ts";

const index = buildMentionIndex();
const chunks = normalize(generateCorpus(), index);

/** Priya Reyes' book. She does not advise Ngozi Okonkwo. */
const REYES_BOOK = new Set([
  "cl_chen_margaret",
  "cl_chen_david",
  "cl_delgado_robert",
  "cl_delgado_elena",
  "cl_okonkwo_adaeze",
  "cl_okonkwo_chidi",
  "cl_whitfield_james",
  "cl_osei_james",
  "cl_marchetti_sofia",
]);

function chunkById(id: string): Chunk {
  const found = chunks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no chunk ${id}`);
  return found;
}

test("firm knowledge is admitted for anyone", () => {
  const firm = chunks.find((c) => c.layer === "firm");
  assert.ok(firm);
  const verdict = fence(firm, {
    subject: "cl_marchetti_sofia",
    authorized: REYES_BOOK,
    index,
  });
  assert.equal(verdict.action, "admit");
});

test("an ambiguous surname that could be the subject is not contamination", () => {
  // The trust paragraph about Adaeze carries "Okonkwo" from the title.
  const verdict = fence(chunkById("ch_plan_plan_okonkwo_trust_0"), {
    subject: "cl_okonkwo_adaeze",
    authorized: REYES_BOOK,
    index,
  });
  assert.equal(verdict.action, "admit");
  assert.ok(verdict.action === "admit" && verdict.ambiguous.length > 0);
});

test("a sibling's own paragraph is refused as someone else's record", () => {
  const verdict = fence(chunkById("ch_plan_plan_okonkwo_trust_1"), {
    subject: "cl_okonkwo_adaeze",
    authorized: REYES_BOOK,
    index,
  });
  assert.equal(verdict.action, "refuse");
  assert.ok(verdict.action === "refuse" && verdict.reason === "other-client-only");
});

test("authorization beats policy: an unauthorized client is refused under redact", () => {
  const verdict = fence(chunkById("ch_plan_plan_okonkwo_trust_2"), {
    subject: "cl_okonkwo_adaeze",
    authorized: REYES_BOOK,
    index,
    policy: "redact",
  });
  assert.equal(verdict.action, "refuse");
  assert.ok(verdict.action === "refuse" && verdict.reason === "not-authorized");
  assert.deepEqual(verdict.action === "refuse" ? verdict.offending : [], ["cl_okonkwo_ngozi"]);
});

test("a shared thread is refused under strict and masked under redact", () => {
  // The Harbor Point message where Osei names his daughter's tuition, seen
  // from Whitfield's side. Both men are on the thread and both are Reyes'.
  const shared = chunks.filter(
    (c) =>
      c.ref.system === "gmail" &&
      c.text.includes("tuition") &&
      c.clients.includes("cl_whitfield_james"),
  );
  assert.ok(shared.length > 0, "expected the tuition message to name both Jameses");

  for (const chunk of shared) {
    const strict = fence(chunk, {
      subject: "cl_whitfield_james",
      authorized: REYES_BOOK,
      index,
    });
    assert.equal(strict.action, "refuse");

    const lenient = fence(chunk, {
      subject: "cl_whitfield_james",
      authorized: REYES_BOOK,
      index,
      policy: "redact",
    });
    if (lenient.action === "redact") {
      assert.ok(lenient.text.includes(MASK));
      assert.ok(!lenient.text.includes("james.osei@example.test"));
    } else {
      assert.equal(lenient.action, "refuse");
    }
  }
});

test("the window invariant throws when another client survives into the text", () => {
  assert.throws(
    () => assertSingleClient("Chidi Okonkwo takes his share in November.", "cl_okonkwo_adaeze", index),
    /fence failure/,
  );
});

test("the window invariant passes on text about the subject alone", () => {
  assertSingleClient("Adaeze Okonkwo defers to November.", "cl_okonkwo_adaeze", index);
});
