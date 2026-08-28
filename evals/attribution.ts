/**
 * Whether a piece of generated text says where it got things.
 *
 * One implementation, because there were two. The eval gate's copy was fixed
 * to attribute by block and to accept a marked gap; the bench's copy was not,
 * so the two reported different numbers for the same property and the bench's
 * "uncited claims" column was measuring a parser artifact that had already
 * been fixed twenty commits earlier.
 *
 * A metric worth gating on is worth having exactly once.
 */

import { NO_SOURCE } from "../src/answer.ts";

export const CITATION = /\[[a-z]+:[a-z-]+\//;

/** A line consisting only of bold or italic text, optionally ending in a colon. */
const BOLD_HEADING = /^(\*{1,3}|_{1,3})[^*_]+\1:?$/;

/**
 * The unit of attribution: a bullet or a paragraph, not a sentence.
 *
 * Sentence splitting was the wrong unit twice over. It cut inside quoted
 * material, so a briefing quoting a source email came apart into an orphaned
 * fragment, and quoting the source is behaviour worth encouraging. And it
 * demanded a key after every sentence, which is not how cited writing works: a
 * two-sentence point drawn from one record carries one citation at the end.
 *
 * Blocks are weaker than sentences, and worth being explicit about. A bullet
 * whose first half came from one record and second half from another passes
 * with only the second cited. Nothing lexical catches that. What does catch the
 * version that matters is the foreign-reference check, which fails if any name
 * in the output resolves to another client.
 */
export function attributionBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current !== "") blocks.push(current);
    current = "";
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    // A line that is nothing but emphasis is a sub-heading written in a
    // different notation than "#", and a heading asserts nothing.
    if (line === "" || line.startsWith("#") || BOLD_HEADING.test(line)) {
      flush();
      continue;
    }
    // A new list item starts a block; anything else continues the current one,
    // so a wrapped line stays with the citation at the end of its bullet.
    if (/^([-*•]|\d+[.)])\s/.test(line) && current !== "") flush();
    current = current === "" ? line : `${current} ${line}`;
  }
  flush();

  return blocks.filter((block) => block.length > 40);
}

export function isAttributed(block: string): boolean {
  return block.includes(NO_SOURCE) || CITATION.test(block);
}

/**
 * Blocks that assert something and cite nothing.
 *
 * One exception, deliberately narrow. A line ending in a colon that introduces
 * the block after it is a lead-in, not a claim, but only when that next block
 * is itself attributed. The same line followed by nothing sourced is an
 * assertion wearing a colon, and still counts.
 */
export function unattributedBlocks(blocks: readonly string[]): string[] {
  return blocks.filter((block, i) => {
    if (isAttributed(block)) return false;
    const next = blocks[i + 1];
    if (block.endsWith(":") && next !== undefined && isAttributed(next)) return false;
    return true;
  });
}

/** Share of blocks citing a real record rather than a gap marker. */
export function sourcedShare(blocks: readonly string[]): number {
  if (blocks.length === 0) return 1;
  return blocks.filter((block) => CITATION.test(block)).length / blocks.length;
}
