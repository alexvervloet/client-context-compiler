/**
 * Three memories, one budget, one client.
 *
 * The output that matters here is not the window, it is the manifest. A
 * context window is a wall of text that looks the same whether the packer made
 * good decisions or terrible ones. The manifest says what was considered, what
 * got in, and what was dropped for which reason, which is the difference
 * between "the model missed it" and "the model never saw it" during an
 * incident review.
 *
 * Budget is split per layer by task, because the layers are not
 * interchangeable. A compliance review that spends its budget on last week's
 * email and skips the firm's documentation standard has failed at the task
 * even though every chunk it admitted was relevant.
 */

import type {
  Chunk,
  ClientId,
  CompileRequest,
  CompiledContext,
  LayerStat,
  ManifestEntry,
  MemoryLayer,
  SourceRef,
  TaskKind,
} from "./types.ts";
import { MEMORY_LAYERS, refKey } from "./types.ts";
import type { Candidate } from "./retrieve.ts";
import { assertSingleClient, fence } from "./fence.ts";
import type { FencePolicy } from "./fence.ts";
import type { MentionIndex } from "./mentions.ts";
import { estimateTokens } from "./tokens.ts";

/**
 * Share of the budget each layer may claim, by task. Unspent share rolls
 * forward, and the client layer is processed last so it inherits the slack.
 */
export const LAYER_BUDGETS: Record<TaskKind, Record<MemoryLayer, number>> = {
  "daily-briefing": { firm: 0.1, conversation: 0.1, client: 0.8 },
  "meeting-prep": { firm: 0.15, conversation: 0.1, client: 0.75 },
  "post-meeting-followup": { firm: 0.1, conversation: 0.25, client: 0.65 },
  "compliance-review": { firm: 0.35, conversation: 0.05, client: 0.6 },
};

/** Layers are filled in this order, so slack flows towards client history. */
const FILL_ORDER: readonly MemoryLayer[] = ["firm", "conversation", "client"];

export type PackInput = {
  request: CompileRequest;
  /** Scored candidates from retrieval: client history and firm knowledge. */
  candidates: Candidate[];
  /** This session's turns, oldest first. Not retrieved, always considered. */
  conversation?: Chunk[];
  /** Every client the advisor may see. */
  authorized: ReadonlySet<ClientId>;
  index: MentionIndex;
  policy?: FencePolicy;
  /** Display name for the window header. */
  clientName: string;
};

type Admitted = {
  chunk: Chunk;
  /** Post-fence text, which may differ from chunk.text under redaction. */
  text: string;
  score: number;
  redactedClients?: ClientId[];
  ambiguousForms: string[];
};

export function pack(input: PackInput): CompiledContext {
  const { request, authorized, index, clientName } = input;
  const policy = input.policy ?? "strict";
  const subject = request.clientId;
  const budgets = LAYER_BUDGETS[request.task];

  const entries: ManifestEntry[] = [];
  const admitted: Record<MemoryLayer, Admitted[]> = { firm: [], client: [], conversation: [] };
  const seenText = new Set<string>();

  // Conversation turns are not retrieved. They are always in the running, most
  // recent first, and they are fenced like anything else.
  const conversationCandidates: Candidate[] = (input.conversation ?? [])
    .slice()
    .reverse()
    .map((chunk) => ({ chunk, similarity: 1, recency: 1, score: 1 }));

  const byLayer: Record<MemoryLayer, Candidate[]> = {
    firm: input.candidates.filter((c) => c.chunk.layer === "firm"),
    client: input.candidates.filter((c) => c.chunk.layer === "client"),
    conversation: conversationCandidates,
  };

  // The window's own furniture costs tokens: the header, and a heading for
  // each layer that ends up with anything in it. Reserve it before handing
  // shares out, rather than discovering it after the fact.
  const scaffold = scaffoldTokens(request, clientName);

  // A budget smaller than the window's own furniture is not an estimator
  // problem, and saying so sends the caller hunting a bug that is not there.
  // The header and layer headings are mandatory; below that, no window exists.
  if (request.budgetTokens < scaffold) {
    throw new Error(
      `a budget of ${request.budgetTokens} tokens is below the ${scaffold} the window ` +
        "header and layer headings cost before any content. Raise the budget; " +
        "nothing has drifted.",
    );
  }

  const available = request.budgetTokens - scaffold;
  let remaining = available;

  for (const layer of FILL_ORDER) {
    const share = Math.floor(available * (budgets[layer] ?? 0));
    // The last layer gets everything left, not just its nominal share.
    const allowance = layer === "client" ? remaining : Math.min(share, remaining);
    let spent = 0;

    for (const candidate of byLayer[layer]) {
      const { chunk } = candidate;

      const verdict = fence(chunk, { subject, authorized, index, policy });
      if (verdict.action === "refuse") {
        entries.push({
          admitted: false,
          chunkId: chunk.id,
          ref: chunk.ref,
          layer,
          tokens: chunk.tokens,
          score: candidate.score,
          reason: verdict.reason === "not-authorized" ? "not-authorized" : "cross-client",
          detail: `${verdict.reason}: ${verdict.offending.join(", ")}`,
        });
        continue;
      }

      const text = verdict.text;
      const fingerprint = text.replace(/\s+/g, " ").trim().toLowerCase();
      if (seenText.has(fingerprint)) {
        entries.push({
          admitted: false,
          chunkId: chunk.id,
          ref: chunk.ref,
          layer,
          tokens: chunk.tokens,
          score: candidate.score,
          reason: "duplicate",
        });
        continue;
      }

      const ambiguousForms = [...new Set(verdict.ambiguous.map((m) => m.form))];
      const record: Admitted = { chunk, text, score: candidate.score, ambiguousForms };
      if (verdict.action === "redact") record.redactedClients = verdict.masked;

      // Cost what will actually be rendered, citation line and blank lines
      // included. Costing the bare chunk and rendering something larger is how
      // a window overflows a budget it was told to respect.
      const cost = estimateTokens(renderRecord(record));

      if (spent + cost > allowance) {
        entries.push({
          admitted: false,
          chunkId: chunk.id,
          ref: chunk.ref,
          layer,
          tokens: cost,
          score: candidate.score,
          reason: spent === 0 ? "over-budget" : "layer-quota",
          detail: `needed ${cost}, ${allowance - spent} left in the ${layer} layer`,
        });
        continue;
      }

      seenText.add(fingerprint);
      spent += cost;
      admitted[layer].push(record);

      const entry: ManifestEntry = {
        admitted: true,
        chunkId: chunk.id,
        ref: chunk.ref,
        layer,
        tokens: cost,
        score: candidate.score,
      };
      if (verdict.action === "redact") entry.redactedClients = verdict.masked;
      entries.push(entry);
    }

    remaining -= spent;
  }

  const text = render(request, clientName, admitted);
  const usedTokens = estimateTokens(text);

  // The last line of defence. If this throws, the fence has a hole and the
  // right thing to do is fail the request, not ship the window.
  assertSingleClient(text, subject, index);

  // A budget that is advisory is not a budget. If accounting has drifted, say
  // so here rather than letting the caller find out from a 400 at request time.
  if (usedTokens > request.budgetTokens) {
    throw new Error(
      `packed window is ${usedTokens} tokens against a budget of ${request.budgetTokens}. ` +
        "Costing and rendering have drifted apart.",
    );
  }

  const layers: Record<MemoryLayer, LayerStat> = {
    firm: layerStat(entries, "firm"),
    client: layerStat(entries, "client"),
    conversation: layerStat(entries, "conversation"),
  };

  const citable = new Map<string, SourceRef>();
  for (const layer of MEMORY_LAYERS) {
    for (const record of admitted[layer]) citable.set(refKey(record.chunk.ref), record.chunk.ref);
  }

  return {
    text,
    citable,
    manifest: {
      request,
      budgetTokens: request.budgetTokens,
      usedTokens,
      candidateCount: entries.length,
      entries,
      layers,
    },
  };
}

function layerStat(entries: readonly ManifestEntry[], layer: MemoryLayer): LayerStat {
  let admittedCount = 0;
  let dropped = 0;
  let tokens = 0;
  for (const entry of entries) {
    if (entry.layer !== layer) continue;
    if (entry.admitted) {
      admittedCount++;
      tokens += entry.tokens;
    } else {
      dropped++;
    }
  }
  return { admitted: admittedCount, dropped, tokens };
}

const LAYER_HEADINGS: Record<MemoryLayer, string> = {
  firm: "Firm knowledge",
  client: "Client history",
  conversation: "This conversation",
};

function windowHeader(request: CompileRequest, clientName: string): string {
  return [
    `# Context for ${clientName} — ${request.task}`,
    "",
    `Compiled ${request.now}. Every passage below carries a citation key in`,
    "square brackets. Cite the key for any claim you make. If nothing here",
    "supports a claim, say so instead of making it.",
  ].join("\n");
}

/**
 * One passage as it appears in the window. Every piece starts with whitespace,
 * which is what makes the token estimate additive: costing the parts and
 * counting the whole give the same answer.
 */
function renderRecord(record: Admitted): string {
  const notes: string[] = [];
  if (record.redactedClients !== undefined && record.redactedClients.length > 0) {
    notes.push("another client's name has been masked");
  }
  if (record.ambiguousForms.length > 0) {
    notes.push(`ambiguous reference: ${record.ambiguousForms.map((f) => `"${f}"`).join(", ")}`);
  }
  const suffix = notes.length > 0 ? ` (${notes.join("; ")})` : "";
  return `\n\n[${refKey(record.chunk.ref)}]${suffix}\n${record.text}`;
}

function scaffoldTokens(request: CompileRequest, clientName: string): number {
  let total = estimateTokens(windowHeader(request, clientName));
  for (const layer of MEMORY_LAYERS) {
    total += estimateTokens(`\n\n## ${LAYER_HEADINGS[layer]}`);
  }
  return total;
}

function render(
  request: CompileRequest,
  clientName: string,
  admitted: Record<MemoryLayer, Admitted[]>,
): string {
  let out = windowHeader(request, clientName);
  for (const layer of MEMORY_LAYERS) {
    const records = admitted[layer];
    if (records.length === 0) continue;
    out += `\n\n## ${LAYER_HEADINGS[layer]}`;
    for (const record of records) out += renderRecord(record);
  }
  return out;
}
