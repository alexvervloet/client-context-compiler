/**
 * A hard ceiling on what a process may spend.
 *
 * This exists because it was missing. A bench in this repository made twelve
 * uncapped calls at Opus rates with adaptive thinking and max_tokens of 16000,
 * and the first thing that stopped it was the account running out of credit.
 * Nothing in the code objected, because nothing in the code was counting.
 *
 * The ledger authorises before the call, not after. Recording actual spend once
 * the response arrives is accounting; refusing the request that would breach
 * the cap is a control. Projection uses the worst case the request could cost,
 * which is max_tokens of output, so the cap is a real ceiling rather than an
 * estimate of a typical one.
 */

import { estimateCostUsd } from "./route.ts";
import type { ModelId } from "./route.ts";

export class SpendCapExceeded extends Error {
  attemptedUsd: number;
  spentUsd: number;
  capUsd: number;

  constructor(attemptedUsd: number, spentUsd: number, capUsd: number, label: string) {
    super(
      `refusing ${label}: it could cost $${attemptedUsd.toFixed(4)}, ` +
        `$${spentUsd.toFixed(4)} is already spent, and the cap is $${capUsd.toFixed(2)}. ` +
        "Raise SPEND_CAP_USD if this is deliberate.",
    );
    this.name = "SpendCapExceeded";
    this.attemptedUsd = attemptedUsd;
    this.spentUsd = spentUsd;
    this.capUsd = capUsd;
  }
}

export type Ledger = {
  readonly capUsd: number;
  spentUsd(): number;
  remainingUsd(): number;
  /** Throws SpendCapExceeded rather than letting the request happen. */
  authorize(projectedUsd: number, label: string): void;
  record(actualUsd: number): void;
  reset(): void;
};

export function makeLedger(capUsd: number): Ledger {
  let spent = 0;
  return {
    capUsd,
    spentUsd: () => spent,
    remainingUsd: () => Math.max(0, capUsd - spent),
    authorize(projectedUsd, label) {
      if (spent + projectedUsd > capUsd) {
        throw new SpendCapExceeded(projectedUsd, spent, capUsd, label);
      }
    },
    record(actualUsd) {
      spent += actualUsd;
    },
    reset() {
      spent = 0;
    },
  };
}

/**
 * Default cap for the process. Deliberately low: this is a demonstration
 * repository, and the failure mode of a cap that is too low is an error
 * message, while the failure mode of one that is too high is a bill.
 */
const DEFAULT_CAP_USD = Number(process.env["SPEND_CAP_USD"] ?? 0.5);

export const ledger: Ledger = makeLedger(DEFAULT_CAP_USD);

/**
 * Voyage list price, USD per million tokens, for the default model.
 *
 * Taken from Voyage's published pricing and not independently verified here.
 * It is used to charge embedding against the same cap as generation; if it is
 * wrong, the cap is wrong in proportion, which is still better than embedding
 * being uncounted entirely.
 */
export const EMBED_PRICE_PER_MTOK = Number(process.env["EMBED_PRICE_PER_MTOK"] ?? 0.18);

export function projectEmbeddingUsd(tokens: number): number {
  return (tokens * EMBED_PRICE_PER_MTOK) / 1_000_000;
}

/** The most a single request could cost, if it generated to its limit. */
export function projectWorstCaseUsd(
  model: ModelId,
  inputTokens: number,
  maxOutputTokens: number,
): number {
  return estimateCostUsd(model, inputTokens, maxOutputTokens);
}
