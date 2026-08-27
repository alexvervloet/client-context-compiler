/**
 * A small runner, because an eval suite that is awkward to run does not get run.
 *
 * Cases are grouped into suites and every suite says whether it is meaningful
 * without a live model. The leak and budget suites are: they test the fence and
 * the packer, both of which are deterministic code. The quality suites are not,
 * and they report as skipped rather than passing quietly against a mock, which
 * would be the worst of both worlds.
 */

export type CaseResult = {
  name: string;
  passed: boolean;
  detail: string;
};

export type Suite = {
  name: string;
  /** What this suite is actually checking, in one line. */
  purpose: string;
  /** False when the suite needs a live model to mean anything. */
  meaningfulOffline: boolean;
  run(): Promise<CaseResult[]>;
};

export type SuiteReport = {
  suite: Suite;
  results: CaseResult[];
  skipped: boolean;
};

export function pass(name: string, detail = ""): CaseResult {
  return { name, passed: true, detail };
}

export function fail(name: string, detail: string): CaseResult {
  return { name, passed: false, detail };
}

export function check(name: string, condition: boolean, detail: string): CaseResult {
  return condition ? pass(name, detail) : fail(name, detail);
}

export async function runSuites(suites: Suite[], live: boolean): Promise<SuiteReport[]> {
  const reports: SuiteReport[] = [];
  for (const suite of suites) {
    if (!suite.meaningfulOffline && !live) {
      reports.push({ suite, results: [], skipped: true });
      continue;
    }
    reports.push({ suite, results: await suite.run(), skipped: false });
  }
  return reports;
}

export function report(reports: SuiteReport[]): { failures: number; text: string } {
  const lines: string[] = [];
  let failures = 0;
  let total = 0;

  for (const { suite, results, skipped } of reports) {
    if (skipped) {
      lines.push(`SKIP  ${suite.name}`);
      lines.push(`      ${suite.purpose}`);
      lines.push("      needs a live model; run with credentials to include it");
      lines.push("");
      continue;
    }

    const failed = results.filter((r) => !r.passed);
    failures += failed.length;
    total += results.length;

    lines.push(`${failed.length === 0 ? "PASS" : "FAIL"}  ${suite.name}  (${results.length - failed.length}/${results.length})`);
    lines.push(`      ${suite.purpose}`);
    for (const result of failed) {
      lines.push(`      x ${result.name}`);
      lines.push(`        ${result.detail}`);
    }
    lines.push("");
  }

  lines.push(
    failures === 0
      ? `All ${total} checks passed.`
      : `${failures} of ${total} checks failed.`,
  );
  return { failures, text: lines.join("\n") };
}
