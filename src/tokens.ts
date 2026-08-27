/**
 * Token counting, twice.
 *
 * Packing is a loop over hundreds of candidates, and each iteration needs a
 * length. A network round trip per candidate is not an option, so the packer
 * runs on a local estimate. The estimate is wrong. `measureEstimatorError`
 * says by how much, against Anthropic's count_tokens, and the number belongs
 * in the README rather than in a footnote nobody reads.
 *
 * The estimator is deliberately biased to overcount. An overcount wastes a
 * little budget; an undercount overflows the window, and an overflowed window
 * fails at request time in front of a user.
 */

import Anthropic from "@anthropic-ai/sdk";

/** Words that a BPE tokenizer usually splits into more than one token. */
const LONG_WORD_CHARS = 4;

/**
 * Local estimate. Word-based rather than character-based, because character
 * ratios drift badly on text with many numbers and email addresses, which is
 * most of what a wealth-management corpus is made of.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;

  let tokens = 0;
  for (const word of text.split(/\s+/)) {
    if (word === "") continue;
    // Punctuation and symbols almost always tokenize on their own.
    const symbols = (word.match(/[^\p{L}\p{N}]/gu) ?? []).length;
    const letters = word.length - symbols;
    tokens += symbols + Math.max(1, Math.ceil(letters / LONG_WORD_CHARS));
  }
  // Newlines are tokens too, and this corpus is full of them.
  tokens += (text.match(/\n/g) ?? []).length;
  return tokens;
}

export type EstimatorError = {
  samples: number;
  /** Mean of (estimate - actual) / actual. Positive means we overcount. */
  meanRelative: number;
  /** Worst overcount and worst undercount seen, as relative errors. */
  maxOver: number;
  maxUnder: number;
  /** How often the estimate came in below the real count. */
  undercountRate: number;
};

/**
 * Compare the estimator against the real tokenizer. Costs nothing beyond the
 * count_tokens calls, which are not billed as inference.
 */
export async function measureEstimatorError(
  samples: string[],
  model = "claude-opus-5",
  client: Anthropic = new Anthropic(),
): Promise<EstimatorError> {
  let sum = 0;
  let maxOver = 0;
  let maxUnder = 0;
  let under = 0;

  const envelope = await measureEnvelopeTokens(model, client);

  for (const text of samples) {
    if (text.trim() === "") continue;
    const response = await client.messages.countTokens({
      model,
      messages: [{ role: "user", content: text }],
    });
    const actual = response.input_tokens - envelope;
    if (actual <= 0) continue;

    const relative = (estimateTokens(text) - actual) / actual;
    sum += relative;
    if (relative > maxOver) maxOver = relative;
    if (relative < maxUnder) maxUnder = relative;
    if (relative < 0) under++;
  }

  const counted = samples.filter((s) => s.trim() !== "").length;
  return {
    samples: counted,
    meanRelative: counted === 0 ? 0 : sum / counted,
    maxOver,
    maxUnder,
    undercountRate: counted === 0 ? 0 : under / counted,
  };
}

/**
 * count_tokens charges for the message wrapper regardless of content, and the
 * amount is a property of the model's tokenizer rather than a constant we get
 * to assume. Measure it once per run and subtract it, so the comparison is
 * estimator against tokenizer and not estimator against tokenizer plus
 * whatever the envelope happened to cost that month.
 */
export async function measureEnvelopeTokens(
  model = "claude-opus-5",
  client: Anthropic = new Anthropic(),
): Promise<number> {
  const probe = "x";
  const response = await client.messages.countTokens({
    model,
    messages: [{ role: "user", content: probe }],
  });
  return Math.max(0, response.input_tokens - estimateTokens(probe));
}
