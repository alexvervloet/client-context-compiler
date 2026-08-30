/**
 * Numeric configuration read from the environment.
 *
 * `Number(process.env["X"] ?? fallback)` looks like it has a default, and it
 * does, but only for the case where the variable is absent. Every other bad
 * value goes straight through:
 *
 *   - `X=abc` is NaN, and NaN is false against every ordered comparison. The
 *     spend cap is enforced by `spent + projected > capUsd`, so a NaN cap
 *     authorizes every request instead of refusing them. Nothing throws.
 *   - `X=` is 0, because `Number("")` is 0 and `??` only defaults on
 *     undefined. An exported-but-empty variable is the shape a shell script
 *     produces when the value it meant to pass was itself unset.
 *   - `X=-5` is a negative timeout or a negative price, both of which the
 *     code downstream has no meaning for.
 *
 * This is the same bug the packer's budget guard was written for: an ordered
 * comparison cannot reject NaN, so the value has to prove it is a number
 * rather than fail to be out of range. The check belongs here, at the read,
 * where the error can name the variable the operator actually set.
 */

/**
 * Read `name` as a number, falling back when it is unset or blank.
 *
 * Throws at import time rather than returning something unusable. A process
 * that refuses to start names the variable it choked on; one that starts with
 * a NaN cap does not, and the first evidence is the bill.
 *
 * `min` is inclusive.
 */
export function numberFromEnv(
  name: string,
  fallback: number,
  min: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];

  // Unset, or set to nothing at all. Both mean "the operator did not choose",
  // and the fallback is the documented choice for that.
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(
      `${name} must be a finite number no less than ${min}, not ${JSON.stringify(raw)}.`,
    );
  }
  return parsed;
}
