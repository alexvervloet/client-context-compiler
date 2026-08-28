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
import { countTokens, measureEstimatorError } from "../src/tokens.ts";
import { elapsed, note, withHeartbeat } from "./progress.ts";

const NOW = "2026-08-27T09:00:00Z";
const BUDGETS = [1000, 2000, 4000, 8000, 16000, 32000, 64000];
/** Big enough that the packer drops nothing for space, so the fence stands alone. */
const FENCE_COST_BUDGET = 100_000;

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
say("Every client, every task, at a budget large enough that nothing is dropped");
say("for space. Measuring this at a tight budget makes the fence look worse as");
say("the budget shrinks, because the share is taken over admitted passages and");
say("those fall; the fence itself refuses the same passages either way.");
say();
say("A held-back passage is one retrieval found, the advisor is authorized to");
say("read, and the compiler refused because it names someone else.");
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
        budgetTokens: FENCE_COST_BUDGET,
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
  const share = ((100 * recovered) / strict.admitted).toFixed(2);
  say(
    recovered > 0
      ? `Redaction admits ${recovered} passages that strict refuses, ` +
          `which is ${share}% more context.`
      : `Redaction admits ${recovered} passages relative to strict (${share}%). ` +
          "The mask is longer than most of the names it replaces, so a redacted " +
          "passage costs more tokens than the original and can push another out.",
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
  say("`raw` is the model on its own. `shipped` is what `estimateTokens`");
  say("returns, safety margin included, and is the one that has to stay");
  say("positive: a window is only inside its budget if the ruler overcounts.");
  say();
  say("| | raw model | shipped |");
  say("| --- | ---: | ---: |");
  say(
    `| mean relative error | ${(error.raw.meanRelative * 100).toFixed(1)}% ` +
      `| ${(error.shipped.meanRelative * 100).toFixed(1)}% |`,
  );
  say(
    `| worst overcount | ${(error.raw.maxOver * 100).toFixed(1)}% ` +
      `| ${(error.shipped.maxOver * 100).toFixed(1)}% |`,
  );
  say(
    `| worst undercount | ${(error.raw.maxUnder * 100).toFixed(1)}% ` +
      `| ${(error.shipped.maxUnder * 100).toFixed(1)}% |`,
  );
  say(
    `| share undercounted | ${(error.raw.undercountRate * 100).toFixed(1)}% ` +
      `| ${(error.shipped.undercountRate * 100).toFixed(1)}% |`,
  );
  say();
  if (error.shipped.undercountRate > 0) {
    say(
      `**The shipped estimator undercounted ${(error.shipped.undercountRate * 100).toFixed(0)}% ` +
        `of samples, worst case ${(error.shipped.maxUnder * 100).toFixed(1)}%.** ` +
        "The budget assertion in pack.ts is measuring with the wrong ruler. " +
        "Raise TOKEN_SAFETY_MARGIN in src/tokens.ts until this row reads 0%.",
    );
  } else {
    say(
      `The shipped estimator never undercounted. It overcounts by ` +
        `${(error.shipped.meanRelative * 100).toFixed(1)}% on average, which is ` +
        "budget spent on nothing and the price of the guarantee holding.",
    );
  }
}
say();

// ------------------------------------------- estimator error on whole windows

say("## Estimator error on a whole window");
say();
say("The per-chunk numbers above are the wrong basis for the safety margin and");
say("are the reason it is as large as it is. The margin has to cover the worst");
say("*chunk*, but the budget is a property of the whole *window*, where a few");
say("hundred chunk-level errors average out. This measures the thing the");
say("guarantee is actually about.");
say();

if (!hasKey) {
  say("Not measured on this run: no Anthropic credentials.");
} else {
  note("counting real tokens for a handful of compiled windows");
  say("| client | task | budget | estimated | actual | error |");
  say("| --- | --- | ---: | ---: | ---: | ---: |");

  const windowCases: Array<{ clientId: string; task: TaskKind; budget: number }> = [
    { clientId: "cl_whitfield_james", task: "meeting-prep", budget: 8000 },
    { clientId: "cl_chen_margaret", task: "compliance-review", budget: 8000 },
    { clientId: "cl_okonkwo_adaeze", task: "meeting-prep", budget: 16000 },
    { clientId: "cl_delgado_robert", task: "daily-briefing", budget: 4000 },
  ];

  const windowErrors: number[] = [];
  for (const [i, c] of windowCases.entries()) {
    note(`  [${i + 1}/${windowCases.length}] ${c.clientId} / ${c.task}`);
    const client = CLIENTS.find((x) => x.id === c.clientId);
    if (client === undefined) continue;
    const compiled = await compiler.compile({
      task: c.task,
      clientId: c.clientId,
      advisorId: client.advisorId,
      budgetTokens: c.budget,
      now: NOW,
    });
    const actual = await countTokens(compiled.text);
    const relative = (compiled.manifest.usedTokens - actual) / actual;
    windowErrors.push(relative);
    say(
      `| ${c.clientId} | ${c.task} | ${c.budget} | ${compiled.manifest.usedTokens} ` +
        `| ${actual} | ${(relative * 100).toFixed(1)}% |`,
    );
  }

  say();
  const worst = Math.min(...windowErrors);
  const mean = windowErrors.reduce((a, b) => a + b, 0) / windowErrors.length;
  say(
    `Window-level error: mean ${(mean * 100).toFixed(1)}%, worst ` +
      `${(worst * 100).toFixed(1)}%. Every window fit inside its budget in real ` +
      `tokens: ${windowErrors.every((e) => e >= 0) ? "yes" : "**no**"}.`,
  );
  say();
  if (worst > 0) {
    const headroom = 1 / (1 + worst);
    say(
      `The margin could come down to about ${(1.3 * headroom).toFixed(2)} and still ` +
        "leave every window in this sample inside its budget, recovering most of " +
        "the wasted space. Four windows is not enough evidence to make that change " +
        "on; widen this sample before touching TOKEN_SAFETY_MARGIN.",
    );
    say();
  }
}

note(`done in ${elapsed(startedAt)}`);
process.stdout.write(`${out.join("\n")}\n`);
