/**
 * Produces the numbers that go in the README, as markdown.
 *
 * Written as a script rather than typed into the README by hand, because a
 * number in a README that nothing regenerates is a number that was true once.
 *
 * Progress goes to stderr, the document to stdout, and `--silent` keeps npm's
 * own banner out of the file:
 *
 *   npm run --silent measure > numbers.md
 */

import { makeCompiler } from "../src/compile.ts";
import { makeMockEmbedder } from "../src/embed.ts";
import { CLIENTS } from "../src/corpus/roster.ts";
import { generateCorpus } from "../src/corpus/generate.ts";
import { normalize } from "../src/normalize.ts";
import { TASK_KINDS } from "../src/types.ts";
import type { TaskKind } from "../src/types.ts";
import type { FencePolicy } from "../src/fence.ts";
import { measureEstimatorError } from "../src/tokens.ts";
import { elapsed, note, withHeartbeat } from "./progress.ts";

const NOW = "2026-08-27T09:00:00Z";
const BUDGETS = [1000, 2000, 4000, 8000, 16000, 32000, 64000];

const startedAt = performance.now();
const out: string[] = [];
const say = (line = ""): void => {
  out.push(line);
};

note("measuring. The markdown goes to stdout, this commentary to stderr.");

// ---------------------------------------------------------------- corpus size

note("generating the corpus and normalizing");
const corpus = generateCorpus();
const chunks = normalize(corpus);
const messages = corpus.threads.reduce((n, t) => n + t.messages.length, 0);
const sharedChunks = chunks.filter((c) => c.clients.length > 1).length;

say("## The corpus");
say();
say("| | count |");
say("| --- | ---: |");
say(`| clients | ${CLIENTS.length} |`);
say(`| email threads | ${corpus.threads.length} |`);
say(`| email messages | ${messages} |`);
say(`| calendar events | ${corpus.events.length} |`);
say(`| meeting notes | ${corpus.notes.length} |`);
say(`| planning documents | ${corpus.plans.length} |`);
say(`| firm documents | ${corpus.firmDocs.length} |`);
say(`| chunks after normalization | ${chunks.length} |`);
say(`| chunks naming more than one client | ${sharedChunks} |`);
say();

// -------------------------------------------------------------- budget sweep

note("building the index for the budget sweep");
const compiler = await makeCompiler({
  embedder: makeMockEmbedder(),
  onIndexProgress: (done, total) => {
    if (done % 384 === 0 || done === total) note(`  embedded ${done}/${total}`);
  },
});
note("running the budget sweep");
const SWEEP_CLIENT = "cl_whitfield_james";
const SWEEP_TASK: TaskKind = "meeting-prep";

say("## What a bigger budget buys");
say();
say(`Meeting prep for James Whitfield, strict fence, mock embeddings.`);
say();
say("| budget | used | fill | passages admitted | dropped for budget | held by the fence |");
say("| ---: | ---: | ---: | ---: | ---: | ---: |");

for (const budgetTokens of BUDGETS) {
  const compiled = await compiler.compile({
    task: SWEEP_TASK,
    clientId: SWEEP_CLIENT,
    advisorId: "adv_reyes",
    budgetTokens,
    now: NOW,
  });
  const m = compiled.manifest;
  const admitted = m.entries.filter((e) => e.admitted).length;
  const budgetDrops = m.entries.filter(
    (e) => !e.admitted && (e.reason === "over-budget" || e.reason === "layer-quota"),
  ).length;
  const fenced = m.entries.filter(
    (e) => !e.admitted && (e.reason === "cross-client" || e.reason === "not-authorized"),
  ).length;
  say(
    `| ${budgetTokens} | ${m.usedTokens} | ${((100 * m.usedTokens) / budgetTokens).toFixed(0)}% ` +
      `| ${admitted} | ${budgetDrops} | ${fenced} |`,
  );
}
say();

// ------------------------------------------------------ what the fence costs

say("## What the fence costs");
say();
say("Every client, every task, 8000-token budget. A held-back passage is one");
say("retrieval found, the advisor is authorized to read, and the compiler");
say("refused because it names someone else.");
say();
say("| policy | passages admitted | held by the fence | share held back |");
say("| --- | ---: | ---: | ---: |");

const policyTotals: Record<string, { admitted: number; fenced: number }> = {};

for (const policy of ["strict", "redact"] as FencePolicy[]) {
  note(`fence cost under ${policy}: ${CLIENTS.length} clients x ${TASK_KINDS.length} tasks`);
  const c = await makeCompiler({ embedder: makeMockEmbedder(), policy });
  let admitted = 0;
  let fenced = 0;
  let done = 0;
  for (const client of CLIENTS) {
    note(`  [${++done}/${CLIENTS.length}] ${client.id}`);
    for (const task of TASK_KINDS) {
      const compiled = await c.compile({
        task,
        clientId: client.id,
        advisorId: client.advisorId,
        budgetTokens: 8000,
        now: NOW,
      });
      for (const entry of compiled.manifest.entries) {
        if (entry.admitted) admitted++;
        else if (entry.reason === "cross-client" || entry.reason === "not-authorized") fenced++;
      }
    }
  }
  policyTotals[policy] = { admitted, fenced };
  const share = ((100 * fenced) / (admitted + fenced)).toFixed(1);
  say(`| ${policy} | ${admitted} | ${fenced} | ${share}% |`);
}
say();

const strict = policyTotals["strict"];
const redact = policyTotals["redact"];
if (strict !== undefined && redact !== undefined) {
  const recovered = redact.admitted - strict.admitted;
  say(
    `Redaction recovers ${recovered} passages that strict refuses, ` +
      `which is ${((100 * recovered) / strict.admitted).toFixed(1)}% more context.`,
  );
  say();
}

// -------------------------------------------------------- estimator accuracy

say("## Token estimator error");
say();
const hasKey =
  (process.env["ANTHROPIC_API_KEY"] ?? "") !== "" ||
  (process.env["ANTHROPIC_AUTH_TOKEN"] ?? "") !== "";

if (!hasKey) {
  say("Not measured on this run: no Anthropic credentials. The estimator's");
  say("accuracy against the real tokenizer is unverified until this is run");
  say("with a key, and the number below should not be quoted from a mock run.");
} else {
  const samples = chunks
    .filter((_, i) => i % 17 === 0)
    .slice(0, 60)
    .map((c) => c.text);
  note(`measuring the estimator against count_tokens over ${samples.length} chunks`);
  const error = await withHeartbeat("count_tokens", note, () =>
    measureEstimatorError(samples, "claude-opus-5", undefined, (done, total) => {
      if (done % 10 === 0 || done === total) note(`  counted ${done}/${total}`);
    }),
  );
  say(`Measured over ${error.samples} chunks against \`count_tokens\`.`);
  say();
  say("| | |");
  say("| --- | ---: |");
  say(`| mean relative error | ${(error.meanRelative * 100).toFixed(1)}% |`);
  say(`| worst overcount | ${(error.maxOver * 100).toFixed(1)}% |`);
  say(`| worst undercount | ${(error.maxUnder * 100).toFixed(1)}% |`);
  say(`| share of chunks undercounted | ${(error.undercountRate * 100).toFixed(1)}% |`);
}
say();

note(`done in ${elapsed(startedAt)}`);
process.stdout.write(`${out.join("\n")}\n`);
