/**
 * The gate. Exits non-zero on any failure, so CI can hold a merge on it.
 *
 * Runs both fence policies deliberately. Strict is the shipping default and
 * redact is the alternative, and a change that fixes one while breaking the
 * other is exactly the regression this is here to catch.
 */

import { report, runSuites } from "./harness.ts";
import { authorizationSuite, leakSuite, trapSuite } from "./leak.ts";
import { budgetSuite } from "./budget.ts";
import { carryoverSuite } from "./carryover.ts";
import { injectionSuite } from "./injection.ts";
import { qualitySuite } from "./quality.ts";

function hasCredentials(): boolean {
  const key = process.env["ANTHROPIC_API_KEY"];
  const token = process.env["ANTHROPIC_AUTH_TOKEN"];
  return (key !== undefined && key !== "") || (token !== undefined && token !== "");
}

const live = hasCredentials() && process.env["EVAL_LIVE"] !== "0";

const suites = [
  leakSuite("strict"),
  leakSuite("redact"),
  trapSuite("strict"),
  trapSuite("redact"),
  authorizationSuite(),
  carryoverSuite(),
  injectionSuite(),
  budgetSuite(),
  qualitySuite(),
];

process.stdout.write(
  live
    ? "\nRunning with credentials. Live suites make model calls and take minutes.\n\n"
    : "\nNo credentials found. Live suites will be skipped.\n\n",
);

const reports = await runSuites(suites, live);
const { failures, text } = report(reports);

process.stdout.write(`\n${text}\n`);
if (!live) {
  process.stdout.write("Set ANTHROPIC_API_KEY to include them.\n");
}
process.exit(failures === 0 ? 0 : 1);
