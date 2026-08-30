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
 *
 * It was not, until somebody measured it. Against `count_tokens` on 2026-08-28
 * the first version ran 15.6% low on average, 29.5% low at worst, and low on
 * 100% of samples. The bias was exactly backwards, so every window that
 * reported fitting its budget was measured with the wrong ruler.
 *
 * Two things were wrong. Digits were counted at the same rate as letters, and
 * a BPE tokenizer groups digits far more tightly, which matters in a corpus
 * made of dates, dollar amounts and account numbers. And nothing enforced the
 * conservative direction; it was an intention in a comment.
 *
 * Now digits are counted separately and there is an explicit margin, and the
 * only thing that keeps either honest is re-running `npm run measure`.
 */

import Anthropic from "@anthropic-ai/sdk";
import { numberFromEnv } from "./env.ts";

/** Letters per token in ordinary prose. */
const LETTERS_PER_TOKEN = 3.4;

/**
 * Digits per token. A BPE tokenizer groups runs of digits, so "2026-05-14" is
 * far more tokens than its ten characters suggest at a prose rate.
 */
const DIGITS_PER_TOKEN = 2;

/**
 * Deliberate overcount, on top of the model above.
 *
 * Derived, not chosen: the structural fix alone closed the measured gap to
 * about 1.17x, and clearing the worst observed 29.5% undercount needs roughly
 * 1.30x. Re-derive it by running `npm run measure` after any change here. If
 * the reported worst undercount is ever above zero, this number is too low.
 *
 * The cost is real. At 1.30 a window admits roughly a fifth less than it could,
 * which is the price of the budget assertion in pack.ts meaning something.
 */
const SAFETY_MARGIN = numberFromEnv("TOKEN_SAFETY_MARGIN", 1.3, 1);

/**
 * Local estimate. Word-based rather than character-based, because character
 * ratios drift badly on text with many numbers and email addresses, which is
 * most of what a wealth-management corpus is made of.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(rawEstimate(text) * SAFETY_MARGIN);
}

/** The model, before the safety margin. Exported so measure can report both. */
export function rawEstimate(text: string): number {
  if (text.length === 0) return 0;

  let tokens = 0;
  for (const word of text.split(/\s+/)) {
    if (word === "") continue;
    // Punctuation and symbols almost always tokenize on their own.
    const symbols = (word.match(/[^\p{L}\p{N}]/gu) ?? []).length;
    const digits = (word.match(/\p{N}/gu) ?? []).length;
    const letters = word.length - symbols - digits;
    tokens +=
      symbols +
      Math.ceil(digits / DIGITS_PER_TOKEN) +
      Math.max(letters > 0 ? 1 : 0, Math.ceil(letters / LETTERS_PER_TOKEN));
  }
  // Newlines are tokens too, and this corpus is full of them.
  tokens += (text.match(/\n/g) ?? []).length;
  return tokens;
}

export type ErrorStats = {
  /** Mean of (estimate - actual) / actual. Positive means we overcount. */
  meanRelative: number;
  /** Worst overcount and worst undercount seen, as relative errors. */
  maxOver: number;
  maxUnder: number;
  /** How often the estimate came in below the real count. Must be zero. */
  undercountRate: number;
};

export type EstimatorError = {
  samples: number;
  /** The model on its own, before the safety margin. */
  raw: ErrorStats;
  /** What `estimateTokens` actually returns, margin included. */
  shipped: ErrorStats;
};

/**
 * Compare the estimator against the real tokenizer. Costs nothing beyond the
 * count_tokens calls, which are not billed as inference.
 */
export async function measureEstimatorError(
  samples: string[],
  model = "claude-opus-5",
  client: Anthropic = new Anthropic(),
  onProgress?: (done: number, total: number) => void,
): Promise<EstimatorError> {
  const envelope = await envelopeFor(model, client);
  const rawErrors: number[] = [];
  const shippedErrors: number[] = [];

  let seen = 0;
  for (const text of samples) {
    if (text.trim() === "") continue;
    const response = await client.messages.countTokens({
      model,
      messages: [{ role: "user", content: text }],
    });
    onProgress?.(++seen, samples.length);
    const actual = response.input_tokens - envelope;
    if (actual <= 0) continue;

    rawErrors.push((rawEstimate(text) - actual) / actual);
    shippedErrors.push((estimateTokens(text) - actual) / actual);
  }

  return {
    samples: shippedErrors.length,
    raw: summarize(rawErrors),
    shipped: summarize(shippedErrors),
  };
}

function summarize(errors: readonly number[]): ErrorStats {
  if (errors.length === 0) {
    return { meanRelative: 0, maxOver: 0, maxUnder: 0, undercountRate: 0 };
  }
  return {
    meanRelative: errors.reduce((a, b) => a + b, 0) / errors.length,
    maxOver: Math.max(...errors, 0),
    maxUnder: Math.min(...errors, 0),
    undercountRate: errors.filter((e) => e < 0).length / errors.length,
  };
}

/**
 * count_tokens charges for the message wrapper regardless of content, and the
 * amount is a property of the model's tokenizer rather than a constant we get
 * to assume. Measure it once per run and subtract it, so the comparison is
 * estimator against tokenizer and not estimator against tokenizer plus
 * whatever the envelope happened to cost that month.
 */
/**
 * The real token count of one string, from the tokenizer rather than a model
 * of it. One network call. Use it to check a finished window, not to pack one.
 */
export async function countTokens(
  text: string,
  model = "claude-opus-5",
  client: Anthropic = new Anthropic(),
): Promise<number> {
  const [response, envelope] = await Promise.all([
    client.messages.countTokens({ model, messages: [{ role: "user", content: text }] }),
    envelopeFor(model, client),
  ]);
  return response.input_tokens - envelope;
}

/**
 * The envelope, measured once per model per process.
 *
 * It used to be measured on every call, so `verifyBudget: true` cost two
 * network round trips per compile rather than the one it advertised.
 */
const envelopeCache = new Map<string, Promise<number>>();

function envelopeFor(model: string, client: Anthropic): Promise<number> {
  const cached = envelopeCache.get(model);
  if (cached !== undefined) return cached;
  const measured = measureEnvelopeTokens(model, client);
  envelopeCache.set(model, measured);
  return measured;
}

export async function measureEnvelopeTokens(
  model = "claude-opus-5",
  client: Anthropic = new Anthropic(),
): Promise<number> {
  const probe = "x";
  const response = await client.messages.countTokens({
    model,
    messages: [{ role: "user", content: probe }],
  });
  // rawEstimate, not estimateTokens. The latter applies the safety margin, so
  // measuring the envelope with it makes the constant used to grade that
  // margin a function of the margin itself.
  return Math.max(0, response.input_tokens - rawEstimate(probe));
}
