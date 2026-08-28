/**
 * Which model handles which request.
 *
 * The interesting input is not the task name, it is the manifest. A window
 * full of redactions and ambiguous references is a harder reasoning problem
 * than a clean one, whatever the task was called, and the routing table can
 * see that before the model does.
 *
 * Everything routes to Opus by default. A cheaper model is a decision that has
 * to earn itself against a measured quality number, which is what evals/ is
 * for. Routing down on a hunch is how a compliance review quietly gets worse.
 */

import type { Manifest, TaskKind } from "./types.ts";

export type ModelId = "claude-opus-5" | "claude-sonnet-5" | "claude-haiku-4-5";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Anthropic list prices, USD per million tokens, cached 2026-06-24. */
export const PRICING: Record<ModelId, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/**
 * What each model's request surface actually accepts.
 *
 * Adaptive thinking and `output_config.effort` arrived with the 4.6 family.
 * Sending either to Haiku 4.5 is a 400, not a silently ignored field, so the
 * request has to be shaped per model. Routing owns this because routing is
 * already the thing that knows which models exist.
 */
export type ModelCapabilities = {
  /** `thinking: { type: "adaptive" }`. */
  adaptiveThinking: boolean;
  /** `output_config: { effort }`. */
  effort: boolean;
};

export const CAPABILITIES: Record<ModelId, ModelCapabilities> = {
  "claude-opus-5": { adaptiveThinking: true, effort: true },
  "claude-sonnet-5": { adaptiveThinking: true, effort: true },
  // Predates both. Sending either returns 400 invalid_request_error.
  "claude-haiku-4-5": { adaptiveThinking: false, effort: false },
};

export type Route = {
  model: ModelId;
  effort: Effort;
  /** Why this route, in one line, for the audit log. */
  rationale: string;
};

/**
 * The base table. Volume work goes to Sonnet; anything that ends up in a
 * compliance file goes to Opus and stays there.
 */
const BASE: Record<TaskKind, Route> = {
  "daily-briefing": {
    model: "claude-sonnet-5",
    effort: "medium",
    rationale: "high volume, one per client per morning, and a person reads it before acting",
  },
  "meeting-prep": {
    model: "claude-opus-5",
    effort: "high",
    rationale: "the advisor walks into a room holding this",
  },
  "post-meeting-followup": {
    model: "claude-sonnet-5",
    effort: "medium",
    rationale: "summarising what was just agreed, with the meeting note in context",
  },
  "compliance-review": {
    model: "claude-opus-5",
    effort: "xhigh",
    rationale: "audited output, and a wrong answer is a finding rather than an annoyance",
  },
};

/** Above this share of admitted passages carrying a caveat, route up. */
const CAVEAT_ESCALATION = 0.15;

export function routeFor(task: TaskKind, manifest?: Manifest): Route {
  const base = BASE[task];
  if (manifest === undefined) return base;

  // Emptiness first, and it wins. A bigger model will not invent the records
  // retrieval did not find, so a thin window routes down however many of its
  // few passages carry caveats. Checked before the escalation below because an
  // almost-empty window trivially has a high share of anything.
  if (manifest.usedTokens < manifest.budgetTokens * 0.1) {
    return {
      model: "claude-haiku-4-5",
      effort: "low",
      rationale:
        "the window is nearly empty; the honest output is short and a larger model cannot fix retrieval",
    };
  }

  const admitted = manifest.entries.filter((e) => e.admitted);
  // Guard the division, not the whole function. Returning `base` here was
  // skipping the emptiness check above in exactly the emptiest case there is.
  if (admitted.length === 0) return base;

  const redacted = admitted.filter(
    (e) => e.admitted && e.redactedClients !== undefined && e.redactedClients.length > 0,
  ).length;

  const share = redacted / admitted.length;
  if (share > CAVEAT_ESCALATION && base.model !== "claude-opus-5") {
    return {
      model: "claude-opus-5",
      effort: "high",
      rationale: `${(share * 100).toFixed(0)}% of admitted passages carry a masked name, which is a harder attribution problem than this task usually is`,
    };
  }

  return base;
}

export function estimateCostUsd(
  model: ModelId,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICING[model];
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}
