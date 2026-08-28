/**
 * Progress reporting for the slow scripts.
 *
 * Everything here writes to stderr on purpose. `measure` and `bench` both emit
 * a markdown document on stdout that is meant to be redirected into a file, so
 * a progress line printed there would end up in the middle of a table.
 *
 * The rule this file exists to enforce: if a step can take minutes, it says
 * something while it does. Silence and a hang look identical from outside, and
 * the first person to run these scripts reported both as a freeze.
 */

export type Note = (line: string) => void;

export const note: Note = (line) => {
  process.stderr.write(`  ${line}\n`);
};

export function elapsed(startedAtMs: number): string {
  return `${((performance.now() - startedAtMs) / 1000).toFixed(1)}s`;
}

/**
 * Report elapsed time while something slow runs, so a call that is thinking
 * hard is distinguishable from one that is wedged.
 */
export async function withHeartbeat<T>(
  label: string,
  report: Note,
  fn: () => Promise<T>,
  everyMs = 15_000,
): Promise<T> {
  const started = performance.now();
  const timer = setInterval(() => {
    report(`  ${label}: still waiting, ${elapsed(started)}`);
  }, everyMs);
  timer.unref();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}
