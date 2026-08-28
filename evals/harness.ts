/**
 * A small runner, because an eval suite that is awkward to run does not get run.
 *
 * Cases are grouped into suites and every suite says whether it is meaningful
 * without a live model. The leak and budget suites are: they test the fence and
 * the packer, both of which are deterministic code. The quality suites are not,
 * and they report as skipped rather than passing quietly against a mock, which
 * would be the worst of both worlds.
 *
 * Output streams as suites finish, and live suites report each case as it goes.
 * The first version printed everything at the end, which is fine for five
 * seconds of deterministic checks and indistinguishable from a hang once a
 * suite starts making model calls that take a minute each.
 */

export type CaseResult = {
  name: string;
  passed: boolean;
  detail: string;
};

/** Called by a slow suite so the terminal shows something is happening. */
export type Progress = (line: string) => void;

export type Suite = {
  name: string;
  /** What this suite is actually checking, in one line. */
  purpose: string;
  /** False when the suite needs a live model to mean anything. */
  meaningfulOffline: boolean;
  run(progress: Progress): Promise<CaseResult[]>;
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

const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export async function runSuites(suites: Suite[], live: boolean): Promise<SuiteReport[]> {
  const reports: SuiteReport[] = [];

  for (const suite of suites) {
    if (!suite.meaningfulOffline && !live) {
      write(`SKIP  ${suite.name}`);
      reports.push({ suite, results: [], skipped: true });
      continue;
    }

    write(`RUN   ${suite.name}`);
    const started = performance.now();
    const results = await suite.run((line) => write(`        ${line}`));
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const failed = results.filter((r) => !r.passed).length;

    write(
      `${failed === 0 ? "PASS" : "FAIL"}  ${suite.name}  ` +
        `(${results.length - failed}/${results.length}, ${seconds}s)`,
    );
    for (const result of results.filter((r) => !r.passed)) {
      write(`      x ${result.name}`);
      write(`        ${result.detail}`);
    }

    reports.push({ suite, results, skipped: false });
  }

  return reports;
}

/** The closing summary. Per-suite lines have already streamed by this point. */
export function report(reports: SuiteReport[]): { failures: number; text: string } {
  const lines: string[] = [];
  let failures = 0;
  let total = 0;
  const skipped: string[] = [];

  for (const { suite, results, skipped: wasSkipped } of reports) {
    if (wasSkipped) {
      skipped.push(suite.name);
      continue;
    }
    failures += results.filter((r) => !r.passed).length;
    total += results.length;
  }

  if (skipped.length > 0) {
    lines.push(`Skipped (needs a live model): ${skipped.join(", ")}.`);
  }
  lines.push(
    failures === 0 ? `All ${total} checks passed.` : `${failures} of ${total} checks failed.`,
  );
  return { failures, text: lines.join("\n") };
}
