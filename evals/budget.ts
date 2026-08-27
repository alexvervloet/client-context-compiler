/**
 * Budget and manifest behaviour.
 *
 * These do not test the model either. They test that the packer respects the
 * number it was handed, that every drop has a reason, and that the manifest
 * describes the window that was actually produced. A manifest that disagrees
 * with its own window is worse than no manifest, because it is the artifact an
 * incident review trusts.
 */

import type { Suite, CaseResult } from "./harness.ts";
import { check } from "./harness.ts";
import { makeCompiler } from "../src/compile.ts";
import { makeMockEmbedder } from "../src/embed.ts";
import { refKey } from "../src/types.ts";
import { CLIENTS, clientById } from "../src/corpus/roster.ts";
import { TASK_KINDS } from "../src/types.ts";

const NOW = "2026-08-27T09:00:00Z";
const BUDGETS = [800, 1500, 4000, 8000, 32000];

export function budgetSuite(): Suite {
  return {
    name: "budget and manifest",
    purpose:
      "Windows fit the budget, drops carry reasons, and the manifest matches the window it describes.",
    meaningfulOffline: true,
    async run() {
      const compiler = await makeCompiler({ embedder: makeMockEmbedder() });
      const results: CaseResult[] = [];

      for (const budgetTokens of BUDGETS) {
        for (const task of TASK_KINDS) {
          const client = CLIENTS[0];
          if (client === undefined) continue;
          const out = await compiler.compile({
            task,
            clientId: client.id,
            advisorId: client.advisorId,
            budgetTokens,
            now: NOW,
          });
          const m = out.manifest;

          results.push(
            check(
              `fits ${budgetTokens} tokens (${task})`,
              m.usedTokens <= budgetTokens,
              `used ${m.usedTokens}`,
            ),
          );

          const reasonless = m.entries.filter((e) => !e.admitted && e.reason === undefined);
          results.push(
            check(
              `every drop has a reason at ${budgetTokens} (${task})`,
              reasonless.length === 0,
              `${reasonless.length} drops without a reason`,
            ),
          );

          const admitted = m.entries.filter((e) => e.admitted);
          const missing = admitted.filter((e) => !out.text.includes(`[${refKey(e.ref)}]`));
          results.push(
            check(
              `manifest matches the window at ${budgetTokens} (${task})`,
              missing.length === 0,
              `${missing.length} passages claimed as admitted are not in the text`,
            ),
          );
        }
      }

      // More budget must never produce a smaller window. A packer that reorders
      // under pressure can violate this, and it is a nasty bug to find later.
      const subject = clientById("cl_chen_margaret");
      let previous = -1;
      let monotonic = true;
      for (const budgetTokens of BUDGETS) {
        const out = await compiler.compile({
          task: "meeting-prep",
          clientId: subject.id,
          advisorId: subject.advisorId,
          budgetTokens,
          now: NOW,
        });
        if (out.manifest.usedTokens < previous) monotonic = false;
        previous = out.manifest.usedTokens;
      }
      results.push(
        check("a larger budget never yields a smaller window", monotonic, "window shrank"),
      );

      return results;
    },
  };
}
