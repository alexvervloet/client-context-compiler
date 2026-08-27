import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildMentionIndex, clientsForEmails, detectMentions } from "../src/mentions.ts";

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
