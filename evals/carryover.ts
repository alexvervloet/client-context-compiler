/**
 * Conversation carry-over.
 *
 * Retrieval is not involved in this failure at all, which is why a suite that
 * only exercises the retriever never finds it. The advisor works one client,
 * then another, in the same session. The previous answer is still in the
 * conversation, and it belongs to somebody else.
 *
 * Every ordered pair of clients on one advisor's book, so the check does not
 * depend on picking a pair that happens to collide.
 */

import type { Suite, CaseResult, Progress } from "./harness.ts";
import { check } from "./harness.ts";
import { makeCompiler } from "../src/compile.ts";
import { makeMockEmbedder } from "../src/embed.ts";
import { newSession, recordTurn } from "../src/session.ts";
import type { Session } from "../src/session.ts";
import { CLIENTS } from "../src/corpus/roster.ts";
import { TASK_KINDS } from "../src/types.ts";

const NOW = "2026-08-27T10:00:00Z";

/**
 * A private detail per client, phrased the way an assistant would have said it
 * in a previous turn. None of these may survive into the next client's window.
 */
const PRIOR_ANSWER: Record<string, string> = {
  cl_osei_james:
    "James has a $58K education obligation due September 12 and needs the Q3 distribution on the original schedule.",
  cl_whitfield_james:
    "He wants to hold the distribution until October so the Riverside parcel closes without a bridge loan.",
  cl_chen_margaret:
    "She has reversed her 2024 position and the muni ladder should not be touched to cover the Kauai reassessment.",
  cl_chen_david:
    "The concentrated position in his consulting LLC escrow is still 31% of his individual account.",
  cl_delgado_robert:
    "The practice sale closes October 3 and the 1031 identification window lands on his Portugal trip.",
  cl_delgado_elena:
    "She needs $145K at closing on September 30 for the Sunnyside condo, two weeks before her RSUs vest.",
  cl_okonkwo_adaeze:
    "Her share funds the practice buy-in and she needs certainty by October.",
  cl_okonkwo_chidi: "He is deferring to November with no stated use for the distribution.",
  cl_marchetti_sofia:
    "Cash flow from the restaurant group supports the full SEP contribution this year.",
};

/** The follow-up that names nobody. The one a subject field has to catch. */
const BLIND_FOLLOWUP = "What about that September obligation? Can we cover it another way?";

function sessionAbout(clientId: string, advisorId: string): Session {
  let session = newSession(`sess_${clientId}`, advisorId);
  session = recordTurn(session, {
    id: `${clientId}_ask`,
    role: "advisor",
    text: "Prep me for this call.",
    clientId,
    at: "2026-08-27T09:00:00Z",
  });
  session = recordTurn(session, {
    id: `${clientId}_answer`,
    role: "assistant",
    text: PRIOR_ANSWER[clientId] ?? "Nothing outstanding.",
    clientId,
    at: "2026-08-27T09:01:00Z",
  });
  session = recordTurn(session, {
    id: `${clientId}_blind`,
    role: "advisor",
    text: BLIND_FOLLOWUP,
    clientId,
    at: "2026-08-27T09:04:00Z",
  });
  return session;
}

/** Distinctive phrases from a prior answer, for substring checking. */
function fingerprints(clientId: string): string[] {
  const answer = PRIOR_ANSWER[clientId];
  if (answer === undefined) return [];
  return answer
    .split(/[.,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25);
}

export function carryoverSuite(): Suite {
  return {
    name: "conversation carry-over",
    purpose:
      "A session turn about one client never enters the next client's window, including turns that name nobody.",
    meaningfulOffline: true,
    async run(progress: Progress) {
      const compiler = await makeCompiler({ embedder: makeMockEmbedder() });
      const results: CaseResult[] = [];
      const book = CLIENTS.filter((c) => c.advisorId === "adv_reyes");

      let index = 0;
      for (const previous of book) {
        index++;
        progress(`[${index}/${book.length}] sessions about ${previous.id}`);
        const session = sessionAbout(previous.id, "adv_reyes");

        for (const next of book) {
          if (next.id === previous.id) continue;
          const out = await compiler.compile(
            {
              task: "meeting-prep",
              clientId: next.id,
              advisorId: "adv_reyes",
              budgetTokens: 8000,
              now: NOW,
            },
            session,
          );

          const survived = fingerprints(previous.id).filter((f) => out.text.includes(f));
          results.push(
            check(
              `${previous.id} -> ${next.id}`,
              survived.length === 0 && out.manifest.layers.conversation.admitted === 0,
              survived.length > 0
                ? `carried over: "${survived[0]}"`
                : `${out.manifest.layers.conversation.admitted} turns admitted from another client's session`,
            ),
          );
        }

        // The same session, compiled for the client it is actually about, must
        // keep its turns. A layer that drops everything passes every check above.
        for (const task of TASK_KINDS) {
          const own = await compiler.compile(
            {
              task,
              clientId: previous.id,
              advisorId: "adv_reyes",
              budgetTokens: 8000,
              now: NOW,
            },
            session,
          );
          results.push(
            check(
              `${previous.id} keeps its own turns (${task})`,
              own.manifest.layers.conversation.admitted > 0,
              "the conversation layer came back empty for its own client",
            ),
          );
        }
      }

      return results;
    },
  };
}
