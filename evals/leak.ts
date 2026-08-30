/**
 * The suite this repository exists for.
 *
 * Every check here is a way for a briefing to be wrong about which client it
 * is about, while every permission check in the system says yes. They run
 * without a model and without a key, because they test deterministic code: the
 * fence, the mention resolver, and the packer.
 */

import type { Suite, CaseResult } from "./harness.ts";
import { check, pass, fail } from "./harness.ts";
import { makeCompiler } from "../src/compile.ts";
import type { Compiler } from "../src/compile.ts";
import { makeMockEmbedder } from "../src/embed.ts";
import { CLIENTS, TRAPS, clientById } from "../src/corpus/roster.ts";
import { TASK_KINDS } from "../src/types.ts";
import type { ClientId, TaskKind } from "../src/types.ts";
import type { FencePolicy } from "../src/fence.ts";
import { foreignMarkers } from "./markers.ts";

const NOW = "2026-08-27T09:00:00Z";

async function compileFor(
  compiler: Compiler,
  clientId: ClientId,
  task: TaskKind,
  budgetTokens = 8000,
) {
  const client = clientById(clientId);
  return await compiler.compile({
    task,
    clientId,
    advisorId: client.advisorId,
    budgetTokens,
    now: NOW,
  });
}

export function leakSuite(policy: FencePolicy): Suite {
  return {
    name: `cross-client leakage (policy: ${policy})`,
    purpose:
      "No window contains another client's name or private detail, across every client and every task.",
    meaningfulOffline: true,
    async run() {
      const compiler = await makeCompiler({ embedder: makeMockEmbedder(), policy });
      const results: CaseResult[] = [];

      for (const client of CLIENTS) {
        for (const task of TASK_KINDS) {
          const out = await compileFor(compiler, client.id, task);
          const name = `${client.id} / ${task}`;

          // Another client's full name, spelled out.
          const named = CLIENTS.filter(
            (other) => other.id !== client.id && out.text.includes(`${other.first} ${other.last}`),
          ).map((other) => other.id);

          // Another client's private detail.
          const leaked = foreignMarkers(client.id).filter(([, marker]) =>
            out.text.includes(marker),
          );

          if (named.length === 0 && leaked.length === 0) {
            results.push(pass(name));
          } else {
            results.push(
              fail(
                name,
                [
                  named.length > 0 ? `names ${named.join(", ")}` : "",
                  leaked.length > 0
                    ? `leaks ${leaked.map(([o, m]) => `${o}:"${m}"`).join(", ")}`
                    : "",
                ]
                  .filter((s) => s !== "")
                  .join("; "),
              ),
            );
          }
        }
      }

      return results;
    },
  };
}

export function trapSuite(policy: FencePolicy): Suite {
  return {
    name: `named traps (policy: ${policy})`,
    purpose: "Each planted trap produces the specific wrong answer it was designed to produce, or does not.",
    meaningfulOffline: true,
    async run() {
      const compiler = await makeCompiler({ embedder: makeMockEmbedder(), policy });
      const results: CaseResult[] = [];

      // The flagship. Osei's tuition on a thread Whitfield is also on.
      const whitfield = await compileFor(compiler, "cl_whitfield_james", "meeting-prep");
      results.push(
        check(
          TRAPS.coInvestors.name,
          !whitfield.text.includes("tuition") && !/\bOsei\b/.test(whitfield.text),
          "Whitfield's meeting prep must not carry Osei's tuition obligation",
        ),
      );

      // The same detail must survive for the client it belongs to. A fence
      // that drops everything would pass every check above this one.
      const osei = await compileFor(compiler, "cl_osei_james", "meeting-prep");
      results.push(
        check(
          `${TRAPS.coInvestors.name} (not over-fenced)`,
          osei.text.includes("tuition"),
          "Osei's own prep must still contain his tuition obligation",
        ),
      );

      // The family trust. Adaeze may see her own sub-account and neither of
      // her siblings', and Ngozi is not on her advisor's book at all.
      const adaeze = await compileFor(compiler, "cl_okonkwo_adaeze", "meeting-prep");
      results.push(
        check(
          TRAPS.familyTrust.name,
          !adaeze.text.includes("sub-account B") &&
            !adaeze.text.includes("sub-account C") &&
            !adaeze.text.includes("divorce"),
          "Adaeze's window must not carry her siblings' sub-accounts or Ngozi's settlement",
        ),
      );

      // Same surname, unrelated, same advisor. Authorization cannot separate
      // these two; only the fence can.
      const robert = await compileFor(compiler, "cl_delgado_robert", "daily-briefing");
      results.push(
        check(
          TRAPS.sameSurname.name,
          !robert.text.includes("Sunnyside") && !/\bElena\b/.test(robert.text),
          "Robert Delgado's briefing must not carry Elena Delgado's condo purchase",
        ),
      );

      // Shared household. Married, joint account, and still two clients.
      const margaret = await compileFor(compiler, "cl_chen_margaret", "meeting-prep");
      results.push(
        check(
          TRAPS.sharedHousehold.name,
          !margaret.text.includes("consulting LLC") && !margaret.text.includes("a boat"),
          "Margaret's prep must not assert David's individual holdings",
        ),
      );

      // Recency. The 2024 note says aggressive; the CRM and the 2026 note say
      // conservative. The window must carry the correction.
      const compliance = await compileFor(compiler, "cl_chen_margaret", "compliance-review");
      const hasCurrent = compliance.text.includes("conservative");
      const hasStaleOnly = compliance.text.includes("aggressive") && !hasCurrent;
      results.push(
        hasStaleOnly
          ? fail(
            TRAPS.staleContradiction.name,
            "the 2024 note reached the window and the 2026 correction did not",
          )
          : check(
            TRAPS.staleContradiction.name,
            hasCurrent,
            "Margaret's compliance review must carry her current conservative rating",
          ),
      );

      return results;
    },
  };
}

export function authorizationSuite(): Suite {
  return {
    name: "authorization",
    purpose: "An advisor never sees a client outside their book, by any route.",
    meaningfulOffline: true,
    async run() {
      const compiler = await makeCompiler({ embedder: makeMockEmbedder(), policy: "redact" });
      const results: CaseResult[] = [];

      for (const client of CLIENTS) {
        const outsiders = CLIENTS.filter((other) => other.advisorId !== client.advisorId);
        const out = await compileFor(compiler, client.id, "meeting-prep");
        const found = outsiders.filter(
          (other) =>
            out.text.includes(`${other.first} ${other.last}`) || out.text.includes(other.email),
        );
        results.push(
          check(
            `${client.id} sees nobody outside ${client.advisorId}'s book`,
            found.length === 0,
            found.length === 0 ? "" : `found ${found.map((o) => o.id).join(", ")}`,
          ),
        );
      }

      // The direct attempt: ask for a client this advisor does not advise.
      try {
        await compiler.compile({
          task: "meeting-prep",
          clientId: "cl_okonkwo_ngozi",
          advisorId: "adv_reyes",
          budgetTokens: 8000,
          now: NOW,
        });
        results.push(fail("cross-book request is rejected", "the compile succeeded"));
      } catch {
        results.push(pass("cross-book request is rejected"));
      }

      return results;
    },
  };
}
