import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildMentionIndex,
  clientsForEmails,
  detectMentions,
  findMentions,
  fold,
} from "../src/mentions.ts";

const index = buildMentionIndex();

test("a full name resolves to one client", () => {
  assert.deepEqual(detectMentions("Margaret Chen asked about the muni ladder.", index), [
    "cl_chen_margaret",
  ]);
});

test("a bare surname stays ambiguous across the household", () => {
  assert.deepEqual(detectMentions("Chen asked about the muni ladder.", index), [
    "cl_chen_david",
    "cl_chen_margaret",
  ]);
});

test("a bare first name shared by two unrelated clients marks both", () => {
  const found = detectMentions("James asked about accelerating the distribution.", index);
  assert.deepEqual(found, ["cl_osei_james", "cl_whitfield_james"]);
});

test("an initial disambiguates where the first name cannot", () => {
  assert.deepEqual(detectMentions("James O. needs his share released.", index), [
    "cl_osei_james",
  ]);
});

test("a longer form claims its characters so the shorter one cannot double-count", () => {
  // "Margaret Chen" must not also fire the bare "Chen" rule and drag in David.
  const found = detectMentions("Margaret Chen and Sofia Marchetti", index);
  assert.deepEqual(found, ["cl_chen_margaret", "cl_marchetti_sofia"]);
});

test("an email address in the body counts as a mention", () => {
  assert.deepEqual(detectMentions("forwarded to ngozi.okonkwo@example.test", index), [
    "cl_okonkwo_ngozi",
  ]);
});

test("a name that is only a substring does not match", () => {
  assert.deepEqual(detectMentions("The Cheney account and the Oseita fund.", index), []);
});

test("unrelated prose mentions nobody", () => {
  assert.deepEqual(detectMentions("Duration is neutral into the autumn.", index), []);
});

test("header addresses map onto clients and ignore the advisor", () => {
  const found = clientsForEmails(
    ["priya.reyes@northgatewealth.test", "MARGARET.CHEN@example.test"],
    index,
  );
  assert.deepEqual(found, ["cl_chen_margaret"]);
});

// A name a reader sees as "Margaret Chen" can be encoded a dozen ways that are
// not that string. Every one of these used to score zero mentions, which meant
// the fence admitted the passage and the final assertion did not fire either.
const OBFUSCATED: Array<[string, string]> = [
  ["a zero-width space inside both names", "Ma\u200brgaret Ch\u200ben"],
  ["Cyrillic letters standing in for Latin", "Ma\u0433garet \u0421hen"],
  ["a soft hyphen inside both names", "Mar\u00adgaret Ch\u00aden"],
  ["a combining accent", "Margaret Che\u0301n"],
  ["fullwidth forms", "\uff2d\uff41\uff52\uff47\uff41\uff52\uff45\uff54 \uff23\uff48\uff45\uff4e"],
  ["a non-breaking space between them", "Margaret\u00a0Chen"],
];

for (const [label, written] of OBFUSCATED) {
  test(`${label} still resolves to the client`, () => {
    assert.deepEqual(detectMentions(`${written} holds the muni ladder.`, index), [
      "cl_chen_margaret",
    ]);
  });
}

test("an obfuscated email address still resolves", () => {
  assert.deepEqual(
    detectMentions("forwarded to ngozi.okonkwo\u200b@example.test", index),
    ["cl_okonkwo_ngozi"],
  );
});

test("a mention's offsets index the original text, not the folded copy", () => {
  // Redaction slices the caller's string, so an offset that pointed into the
  // folded copy would mask the wrong characters, or half a name.
  const text = "Ahead of the review, Ma\u200brgaret Ch\u200ben asked about Kauai.";
  const [mention] = findMentions(text, index);
  assert.ok(mention !== undefined);
  assert.deepEqual(mention.candidates, ["cl_chen_margaret"]);
  assert.equal(text.slice(mention.start, mention.end), "Ma\u200brgaret Ch\u200ben");
  // And the span swallows the invisible characters rather than leaving them.
  const masked = text.slice(0, mention.start) + "[another client]" + text.slice(mention.end);
  assert.equal(masked, "Ahead of the review, [another client] asked about Kauai.");
  assert.deepEqual(detectMentions(masked, index), []);
});

test("folding does not invent mentions in ordinary prose", () => {
  // The fold lowercases and strips accents, which is exactly the kind of
  // change that turns a near-miss into a false positive if it goes too far.
  assert.deepEqual(detectMentions("The Cheney account and the Oseita fund.", index), []);
  assert.deepEqual(detectMentions("Duration is neutral into the autumn.", index), []);
});

test("fold offsets stay aligned when a character expands", () => {
  // NFKC turns one character into two here, which would slide every later
  // offset if folding ran over the whole string instead of per character.
  const text = "the \ufb01rst Margaret Chen review";
  const folded = fold(text);
  assert.equal(folded.text, "the first margaret chen review");
  const at = folded.text.indexOf("margaret chen");
  const from = folded.offsets[at];
  const to = folded.offsets[at + "margaret chen".length];
  assert.equal(text.slice(from, to), "Margaret Chen");
});
