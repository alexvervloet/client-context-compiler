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
 *   secrun npm run bench
 *   secrun npm run bench -- --models claude-opus-5,claude-haiku-4-5
 */

import { parseArgs } from "node:util";
import { makeCompiler } from "../src/compile.ts";
import { answer } from "../src/answer.ts";
import { resolveEmbedder } from "../src/embed.ts";
import { findMentions } from "../src/mentions.ts";
import { PRICING } from "../src/route.ts";
import type { ModelId } from "../src/route.ts";
import { clientById } from "../src/corpus/roster.ts";
import { TASK_KINDS } from "../src/types.ts";
import type { TaskKind } from "../src/types.ts";

const NOW = "2026-08-27T09:00:00Z";
const BUDGET = 12000;

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
  },
});

const models = (values.models ?? "claude-opus-5,claude-sonnet-5,claude-haiku-4-5").split(
  ",",
) as ModelId[];
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

/** A sentence that asserts something. Headings and bullets markers do not. */
function factualSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.?!])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && !s.startsWith("#"));
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
};

const compiler = await makeCompiler({ embedder: resolveEmbedder() });
const rows: Row[] = [];

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

  for (const model of models) {
    for (let i = 0; i < repeats; i++) {
      const started = performance.now();
      const out = await answer({
        context,
        task,
        route: { model, effort: "high", rationale: "bench" },
      });
      const ms = performance.now() - started;

      const foreignRefs = findMentions(out.text, compiler.mentions).filter(
        (m) => !m.candidates.includes(clientId),
      ).length;

      rows.push({
        task,
        model,
        ms,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        costUsd: out.costUsd,
        fabricated: out.fabricatedKeys.length,
        uncited: factualSentences(out.text).filter((s) => !s.includes("[")).length,
        foreignRefs,
      });
    }
  }
}

// ------------------------------------------------------------------- report

const say = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

say();
say("## Model comparison");
say();
say(
  `Same compiled window per task, ${BUDGET}-token budget, ${repeats} run(s) each. ` +
    "Foreign refs is the one that matters: a name in the output resolving to a client",
);
say("other than the one the window was compiled for.");
say();
say("| task | model | p50 latency | in | out | cost | fabricated keys | uncited claims | foreign refs |");
say("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");

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
    say(
      `| ${task} | ${model} | ${median(group.map((r) => r.ms)).toFixed(0)} ms ` +
        `| ${Math.round(sum((r) => r.inputTokens) / group.length)} ` +
        `| ${Math.round(sum((r) => r.outputTokens) / group.length)} ` +
        `| $${(sum((r) => r.costUsd) / group.length).toFixed(4)} ` +
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
