/**
 * The eval's own parser, pinned.
 *
 * Every case in here is a shape a real model produced against this corpus. The
 * first three were false failures the sentence splitter reported before this
 * existed, and the last two are what it has to keep catching.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { attributionBlocks, CITATION } from "../evals/quality.ts";
import { NO_SOURCE } from "../src/answer.ts";

function attributed(text: string): boolean[] {
  return attributionBlocks(text).map(
    (block) => block.includes(NO_SOURCE) || CITATION.test(block),
  );
}

test("a wrapped paragraph keeps the citation at its end", () => {
  const text = [
    "**Riverside parcel — needs an answer.** On 2026-08-18 the client forwarded",
    "a broker note offering the parcel at $2.4M with a 30-day close. The message",
    "also carried an instruction I have not acted on [gmail:message/t_fwd_m0].",
  ].join("\n");
  assert.deepEqual(attributed(text), [true]);
});

test("a quotation containing a full stop does not split the block", () => {
  const text = `- IPS review: the change was "updated in our system and with the custodian." Both confirmed [notes:meeting-note/note_7_2].`;
  assert.deepEqual(attributed(text), [true]);
});

test("a quoted question keeps its bullet intact", () => {
  const text = [
    '- 2026-08-04, on "Tax documents," she wrote "That is lower than I expected.',
    '  Is that right?" and no reply appears [gmail:message/t_9_3].',
  ].join("\n");
  assert.deepEqual(attributed(text), [true]);
});

test("each list item is its own block", () => {
  const text = [
    "- First point, drawn from the record [crm:contact/8812].",
    "- Second point, drawn from another one [gmail:message/abc].",
  ].join("\n");
  assert.equal(attributionBlocks(text).length, 2);
  assert.deepEqual(attributed(text), [true, true]);
});

test("a marked gap counts as attributed", () => {
  const text = "- There is no meeting note for the August session at all. [no source]";
  assert.deepEqual(attributed(text), [true]);
});

test("an uncited assertion is still caught", () => {
  const text = "The client is comfortable moving to an aggressive allocation this quarter.";
  assert.deepEqual(attributed(text), [false]);
});

test("a citation on one bullet does not cover the next", () => {
  const text = [
    "- The distribution is unresolved between the co-owners [gcal:event/ev_hp].",
    "- The client has decided to sell the whole position before year end.",
  ].join("\n");
  assert.deepEqual(attributed(text), [true, false]);
});

test("headings are not claims and do not need citing", () => {
  const text = [
    "## Needs an answer today",
    "",
    "Nothing in the window is outstanding for this client today. [no source]",
  ].join("\n");
  const blocks = attributionBlocks(text);
  assert.equal(blocks.length, 1, "the heading should not be a block");
  assert.ok(blocks[0]?.startsWith("Nothing in the window"));
});

test("a line too short to be a claim is not counted", () => {
  assert.deepEqual(attributionBlocks("Two open items."), []);
});
