/**
 * A CLI, mostly so the manifest is easy to look at.
 *
 * `compile` prints the window. `manifest` prints the decisions behind it,
 * which is the more useful of the two when something looks wrong.
 */

import { parseArgs } from "node:util";
import { makeCompiler } from "./compile.ts";
import { answer } from "./answer.ts";
import { CLIENTS, clientById } from "./corpus/roster.ts";
import { refKey, TASK_KINDS } from "./types.ts";
import type { Manifest, ManifestEntry, TaskKind } from "./types.ts";
import type { FencePolicy } from "./fence.ts";
import { routeFor } from "./route.ts";

const USAGE = `
client-context-compiler

  npm run ccc -- clients
  npm run ccc -- compile  <clientId> <task> [options]
  npm run ccc -- manifest <clientId> <task> [options]
  npm run ccc -- answer   <clientId> <task> [options]
  npm run ccc -- sweep    <clientId> <task> [options]

Tasks:   ${TASK_KINDS.join(", ")}

Options:
  --budget <n>            token budget for the window (default 8000)
  --policy <strict|redact> fence policy (default strict)
  --query <text>          extra retrieval steer
  --now <iso>             fixed clock (default 2026-08-27T09:00:00Z)
`;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    budget: { type: "string" },
    policy: { type: "string" },
    query: { type: "string" },
    now: { type: "string" },
  },
});

const command = positionals[0];

function requireBudget(value: string | undefined): number {
  const parsed = Number(value ?? 8000);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    // Number("abc") is NaN, and NaN compares false against every bound the
    // packer checks. Catching it here means the error names the flag the user
    // typed rather than surfacing three layers down.
    throw new Error(`--budget must be a positive number, not ${JSON.stringify(value)}`);
  }
  return parsed;
}

const budgetTokens = requireBudget(values.budget);
const policy = (values.policy ?? "strict") as FencePolicy;
const now = values.now ?? "2026-08-27T09:00:00Z";

function requireTask(value: string | undefined): TaskKind {
  if (value !== undefined && (TASK_KINDS as readonly string[]).includes(value)) {
    return value as TaskKind;
  }
  throw new Error(`task must be one of: ${TASK_KINDS.join(", ")}`);
}

function printManifest(manifest: Manifest): void {
  const { layers } = manifest;
  process.stdout.write(
    `\nbudget ${manifest.budgetTokens}  used ${manifest.usedTokens}  ` +
      `(${((100 * manifest.usedTokens) / manifest.budgetTokens).toFixed(1)}% full)  ` +
      `candidates ${manifest.candidateCount}\n\n`,
  );
  process.stdout.write("layer         admitted  dropped   tokens\n");
  for (const [name, stat] of Object.entries(layers)) {
    process.stdout.write(
      `${name.padEnd(14)}${String(stat.admitted).padStart(8)}${String(stat.dropped).padStart(9)}` +
        `${String(stat.tokens).padStart(9)}\n`,
    );
  }

  const reasons = new Map<string, number>();
  for (const entry of manifest.entries) {
    if (entry.admitted) continue;
    reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1);
  }
  if (reasons.size > 0) {
    process.stdout.write("\ndropped, by reason\n");
    for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`  ${reason.padEnd(18)}${String(count).padStart(4)}\n`);
    }
  }

  const crossClient = manifest.entries.filter(
    (e): e is Extract<ManifestEntry, { admitted: false }> =>
      !e.admitted && (e.reason === "cross-client" || e.reason === "not-authorized"),
  );
  if (crossClient.length > 0) {
    process.stdout.write("\nheld back by the fence\n");
    for (const entry of crossClient.slice(0, 12)) {
      process.stdout.write(`  ${refKey(entry.ref).padEnd(38)} ${entry.detail ?? ""}\n`);
    }
    if (crossClient.length > 12) {
      process.stdout.write(`  ... and ${crossClient.length - 12} more\n`);
    }
  }
}

if (command === undefined || command === "help") {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (command === "clients") {
  process.stdout.write("\nclientId                  name                 advisor       household\n");
  for (const client of CLIENTS) {
    process.stdout.write(
      `${client.id.padEnd(26)}${`${client.first} ${client.last}`.padEnd(21)}` +
        `${client.advisorId.padEnd(14)}${client.householdId}\n`,
    );
  }
  process.exit(0);
}

const clientId = positionals[1];
if (clientId === undefined) {
  process.stderr.write("a clientId is required. Try: npm run ccc -- clients\n");
  process.exit(2);
}
const task = requireTask(positionals[2]);
const client = clientById(clientId);
const compiler = await makeCompiler({ policy });

const request = {
  task,
  clientId,
  advisorId: client.advisorId,
  budgetTokens,
  now,
  ...(values.query === undefined ? {} : { query: values.query }),
};

if (command === "sweep") {
  process.stdout.write("\nbudget    used    fill   admitted  dropped  fenced\n");
  for (const budget of [1000, 2000, 4000, 8000, 16000, 32000, 64000]) {
    const out = await compiler.compile({ ...request, budgetTokens: budget });
    const m = out.manifest;
    const admitted = m.entries.filter((e) => e.admitted).length;
    const fenced = m.entries.filter(
      (e) => !e.admitted && (e.reason === "cross-client" || e.reason === "not-authorized"),
    ).length;
    process.stdout.write(
      `${String(budget).padStart(6)}${String(m.usedTokens).padStart(8)}` +
        `${`${((100 * m.usedTokens) / budget).toFixed(0)}%`.padStart(8)}` +
        `${String(admitted).padStart(11)}${String(m.entries.length - admitted).padStart(9)}` +
        `${String(fenced).padStart(8)}\n`,
    );
  }
  process.exit(0);
}

const compiled = await compiler.compile(request);

if (command === "compile") {
  process.stdout.write(`${compiled.text}\n`);
  printManifest(compiled.manifest);
} else if (command === "manifest") {
  printManifest(compiled.manifest);
} else if (command === "answer") {
  const route = routeFor(task, compiled.manifest);
  process.stdout.write(`\nrouted to ${route.model} (effort ${route.effort})\n  ${route.rationale}\n\n`);
  const result = await answer({ context: compiled, task });
  process.stdout.write(`${result.text}\n\n`);
  process.stdout.write(
    `cited ${result.citedKeys.length} sources, ${result.fabricatedKeys.length} fabricated, ` +
      `$${result.costUsd.toFixed(5)}${result.isMock ? " (mock)" : ""}\n`,
  );
} else {
  process.stderr.write(`unknown command: ${command}\n${USAGE}`);
  process.exit(2);
}
