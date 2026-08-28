/**
 * Model comparison, for deciding what routes where.
 *
 * The routing table in `src/route.ts` currently carries rationales and no
 * numbers, which makes it an opinion. This produces the numbers: latency,
 * cost, and three quality measures per task per model, over the same compiled
 * windows, so the only variable is the model.
 *
 * It refuses to run without credentials. A model bench against a mock would
 * produce a table that looks exactly like a real one and means nothing, and
 * that table would end up in a README.
 *
 * It also refuses to spend anything until you have seen what it will cost.
 * The first version of this file did not: it made twelve calls with adaptive
 * thinking, effort forced to high on every model including Opus, and
 * max_tokens of 16000, and the thing that eventually stopped it was the
 * account running out of credit. So the default now is a dry run that prints
 * a projection and exits, Opus is opt-in rather than included, and every call
 * goes through the spend ledger.
 *
 *   npm run bench                          # dry run: what would this cost?
 *   secrun npm run bench -- --confirm      # actually spend it
 *   secrun npm run bench -- --confirm --models claude-opus-5
 *   SPEND_CAP_USD=2 secrun npm run bench -- --confirm
 */

import { parseArgs } from "node:util";
import { makeCompiler } from "../src/compile.ts";
import { answer } from "../src/answer.ts";
import { resolveEmbedder } from "../src/embed.ts";
import { findMentions } from "../src/mentions.ts";
import { PRICING, routeFor } from "../src/route.ts";
import type { ModelId } from "../src/route.ts";
import { clientById } from "../src/corpus/roster.ts";
import { TASK_KINDS } from "../src/types.ts";
import type { TaskKind } from "../src/types.ts";
import { elapsed, note, withHeartbeat } from "./progress.ts";
import { ledger, projectWorstCaseUsd } from "../src/spend.ts";
import { estimateTokens } from "../src/tokens.ts";
import { buildPrompt } from "../src/answer.ts";
import { attributionBlocks, unattributedBlocks } from "./attribution.ts";
import { measureRecall } from "./findings.ts";

const NOW = "2026-08-27T09:00:00Z";
const BUDGET = 12000;

/** Mirrors the per-task output ceilings in answer.ts, for the projection. */
const MAX_OUTPUT: Record<TaskKind, number> = {
  "daily-briefing": 3000,
  "meeting-prep": 4000,
  "post-meeting-followup": 3000,
  "compliance-review": 5000,
};

/** One client per task, chosen to sit on a trap rather than an easy file. */
const SUBJECTS: Record<TaskKind, string> = {
  "daily-briefing": "cl_delgado_robert",
  "meeting-prep": "cl_whitfield_james",
  "post-meeting-followup": "cl_osei_james",
  "compliance-review": "cl_chen_margaret",
};

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    models: { type: "string" },
    repeats: { type: "string" },
    confirm: { type: "boolean" },
  },
});

// Opus is not in the default set. Adding it is a decision someone makes on
// purpose, having seen the projection.
const models = (values.models ?? "claude-haiku-4-5,claude-sonnet-5").split(",") as ModelId[];
const repeats = Number(values.repeats ?? 1);

const hasKey =
  (process.env["ANTHROPIC_API_KEY"] ?? "") !== "" ||
  (process.env["ANTHROPIC_AUTH_TOKEN"] ?? "") !== "";

if (!hasKey) {
  process.stderr.write(
    [
      "",
      "  This bench needs Anthropic credentials and will not run against the mock.",
      "  A model comparison built from stub output looks identical to a real one",
      "  and means nothing, and that table would end up in a README.",
      "",
      "    secrun npm run bench",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

type Row = {
  task: TaskKind;
  model: ModelId;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  fabricated: number;
  uncited: number;
  foreignRefs: number;
  /** Findings the window supported and the answer surfaced. */
  found: number;
  supported: number;
  missedLabels: string[];
};

const benchStartedAt = performance.now();
const totalCalls = TASK_KINDS.length * models.length * repeats;

const embedder = resolveEmbedder();
note(`building the index with ${embedder.name}`);
const compiler = await makeCompiler({
  embedder,
  onIndexProgress: (done, total) => {
    if (done % 384 === 0 || done === total) note(`  embedded ${done}/${total}`);
  },
});

// ------------------------------------------------- what is this going to cost

const contexts = new Map<TaskKind, Awaited<ReturnType<typeof compiler.compile>>>();
let worstCaseUsd = 0;

for (const task of TASK_KINDS) {
  const clientId = SUBJECTS[task];
  const client = clientById(clientId);
  const context = await compiler.compile({
    task,
    clientId,
    advisorId: client.advisorId,
    budgetTokens: BUDGET,
    now: NOW,
  });
  contexts.set(task, context);

  const promptTokens = estimateTokens(buildPrompt(context, task));
  for (const model of models) {
    worstCaseUsd += projectWorstCaseUsd(model, promptTokens, MAX_OUTPUT[task]) * repeats;
  }
}

note("");
note(`${totalCalls} calls: ${TASK_KINDS.length} tasks x ${models.length} models x ${repeats}.`);
note(`models: ${models.join(", ")}`);
note(`worst case if every call generates to its limit: $${worstCaseUsd.toFixed(2)}`);
note(`spend cap for this process: $${ledger.capUsd.toFixed(2)} (SPEND_CAP_USD)`);
note("");

if (values.confirm !== true) {
  note("Dry run. Nothing has been spent and nothing will be.");
  note("Re-run with --confirm to make the calls:");
  note("");
  note(`  secrun npm run bench -- --confirm${values.models === undefined ? "" : ` --models ${values.models}`}`);
  note("");
  process.exit(0);
}

if (worstCaseUsd > ledger.capUsd) {
  note(
    `Refusing to start: the worst case ($${worstCaseUsd.toFixed(2)}) is above the ` +
      `cap ($${ledger.capUsd.toFixed(2)}). Either drop a model or raise the cap ` +
      "deliberately with SPEND_CAP_USD.",
  );
  process.exit(2);
}

const rows: Row[] = [];
let call = 0;

for (const task of TASK_KINDS) {
  const clientId = SUBJECTS[task];
  const context = contexts.get(task);
  if (context === undefined) continue;
  note(`${task} (${clientId}): window is ${context.manifest.usedTokens} tokens`);

  for (const model of models) {
    for (let i = 0; i < repeats; i++) {
      const label = `${task} on ${model}`;
      note(`[${++call}/${totalCalls}] ${label} ...`);
      const started = performance.now();
      // Effort comes from what this task would actually route at, not forced
      // to high for everything. Forcing high on every model is what made the
      // first version of this bench expensive.
      const effort = routeFor(task).effort;
      const out = await withHeartbeat(label, note, () =>
        answer({ context, task, route: { model, effort, rationale: "bench" } }),
      );
      const ms = performance.now() - started;
      note(
        `[${call}/${totalCalls}] ${label}: ${(ms / 1000).toFixed(1)}s, ` +
          `${out.outputTokens} out, $${out.costUsd.toFixed(4)}`,
      );

      const foreignRefs = findMentions(out.text, compiler.mentions).filter(
        (m) => !m.candidates.includes(clientId),
      ).length;
      const recall = measureRecall(task, context.text, out.text);

      rows.push({
        task,
        model,
        ms,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        costUsd: out.costUsd,
        fabricated: out.fabricatedKeys.length,
        uncited: unattributedBlocks(attributionBlocks(out.text)).length,
        foreignRefs,
        found: recall.found.length,
        supported: recall.supported.length,
        missedLabels: recall.missed.map((f) => f.label),
      });
    }
  }
}

// ------------------------------------------------------------------- report

const say = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

note(
  `all ${totalCalls} calls done in ${elapsed(benchStartedAt)}, ` +
    `$${ledger.spentUsd().toFixed(4)} spent of a $${ledger.capUsd.toFixed(2)} cap`,
);

say();
say("## Model comparison");
say();
say(
  `Same compiled window per task, ${BUDGET}-token budget, ${repeats} run(s) each. ` +
    "Foreign refs is the one that matters: a name in the output resolving to a client",
);
say("other than the one the window was compiled for.");
say();
say(
  "| task | model | p50 latency | in | out | cost | findings found | fabricated keys | uncited | foreign refs |",
);
say("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

for (const task of TASK_KINDS) {
  for (const model of models) {
    const group = rows.filter((r) => r.task === task && r.model === model);
    if (group.length === 0) continue;
    const sum = (pick: (r: Row) => number): number => group.reduce((n, r) => n + pick(r), 0);
    const first = group[0];
    say(
      `| ${task} | ${model} | ${median(group.map((r) => r.ms)).toFixed(0)} ms ` +
        `| ${Math.round(sum((r) => r.inputTokens) / group.length)} ` +
        `| ${Math.round(sum((r) => r.outputTokens) / group.length)} ` +
        `| $${(sum((r) => r.costUsd) / group.length).toFixed(4)} ` +
        `| ${sum((r) => r.found) / group.length}/${first?.supported ?? 0} ` +
        `| ${sum((r) => r.fabricated)} | ${sum((r) => r.uncited)} | ${sum((r) => r.foreignRefs)} |`,
    );
  }
}

say();
say("### Cost per thousand briefings");
say();
say("| model | $ per 1,000 daily briefings |");
say("| --- | ---: |");
for (const model of models) {
  const group = rows.filter((r) => r.task === "daily-briefing" && r.model === model);
  if (group.length === 0) continue;
  const mean = group.reduce((n, r) => n + r.costUsd, 0) / group.length;
  say(`| ${model} | $${(mean * 1000).toFixed(2)} |`);
}
say();
say(`List prices used: ${models.map((m) => `${m} $${PRICING[m].input}/$${PRICING[m].output}`).join(", ")} per MTok.`);
say();

say("### What each model missed");
say();
say("A finding is only counted when the compiled window actually contained it,");
say("so a miss here is the model skipping something it was shown, not retrieval");
say("failing to find it. This is the column that decides whether routing down is");
say("a saving or a quiet regression: safety numbers stay clean when a model");
say("simply writes less.");
say();

const missed = rows.filter((r) => r.missedLabels.length > 0);
if (missed.length === 0) {
  say("Nothing. Every model surfaced every supported finding.");
} else {
  for (const row of missed) {
    say(`- **${row.model}** on ${row.task}: ${row.missedLabels.join("; ")}`);
  }
}
say();

const leaks = rows.filter((r) => r.foreignRefs > 0 || r.fabricated > 0);
if (leaks.length > 0) {
  say("### Failures worth reading before quoting any of the above");
  say();
  for (const row of leaks) {
    say(
      `- ${row.model} on ${row.task}: ${row.foreignRefs} foreign reference(s), ` +
        `${row.fabricated} fabricated key(s).`,
    );
  }
  say();
}
