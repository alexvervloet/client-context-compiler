import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeCompiler } from "../src/compile.ts";
import { makeMockEmbedder } from "../src/embed.ts";
import { newSession, recordTurn } from "../src/session.ts";
import type { Session } from "../src/session.ts";

const NOW = "2026-08-27T09:30:00Z";
const compiler = await makeCompiler({ embedder: makeMockEmbedder() });

/**
 * A morning that actually happens: prep for one client, then prep for another,
 * in the same session, with the advisor asking a follow-up that names nobody.
 */
function morningSession(): Session {
  let session = newSession("sess_morning", "adv_reyes");
  session = recordTurn(session, {
    id: "t1",
    role: "advisor",
    text: "Prep me for the Osei call.",
    clientId: "cl_osei_james",
    at: "2026-08-27T09:00:00Z",
  });
  session = recordTurn(session, {
    id: "t2",
    role: "assistant",
    text: "James has a $58K education obligation due September 12 and wants his Q3 distribution released on the original schedule.",
    clientId: "cl_osei_james",
    at: "2026-08-27T09:01:00Z",
  });
  // The dangerous one. Names nobody, so mention detection finds nothing.
  session = recordTurn(session, {
    id: "t3",
    role: "advisor",
    text: "What about the September obligation? Can we cover it another way?",
    clientId: "cl_osei_james",
    at: "2026-08-27T09:04:00Z",
  });
  return session;
}

test("a session turn reaches the window of the client it was about", async () => {
  const out = await compiler.compile(
    {
      task: "post-meeting-followup",
      clientId: "cl_osei_james",
      advisorId: "adv_reyes",
      budgetTokens: 8000,
      now: NOW,
    },
    morningSession(),
  );
  assert.ok(out.manifest.layers.conversation.admitted > 0, "Osei's own turns should be admitted");
  assert.ok(out.text.includes("September obligation"));
});

test("session turns do not carry over to the next client", async () => {
  const out = await compiler.compile(
    {
      task: "meeting-prep",
      clientId: "cl_whitfield_james",
      advisorId: "adv_reyes",
      budgetTokens: 8000,
      now: NOW,
    },
    morningSession(),
  );
  assert.equal(out.manifest.layers.conversation.admitted, 0);
  assert.equal(out.manifest.layers.conversation.dropped, 3);
  assert.ok(!out.text.includes("$58K"));
  assert.ok(!out.text.includes("September obligation"));
  assert.ok(!out.text.includes("Prep me for the Osei call"));
});

test("a turn naming nobody is still refused, on its recorded subject alone", async () => {
  const out = await compiler.compile(
    {
      task: "meeting-prep",
      clientId: "cl_whitfield_james",
      advisorId: "adv_reyes",
      budgetTokens: 8000,
      now: NOW,
    },
    morningSession(),
  );
  const turn = out.manifest.entries.find((e) => e.chunkId === "ch_turn_t3");
  assert.ok(turn !== undefined, "the ambiguous follow-up should appear in the manifest");
  assert.equal(turn.admitted, false);
  assert.ok(!turn.admitted && turn.reason === "cross-client");
});

test("a session belonging to another advisor is rejected", async () => {
  const session = newSession("sess_other", "adv_hartman");
  await assert.rejects(
    () =>
      compiler.compile(
        {
          task: "meeting-prep",
          clientId: "cl_whitfield_james",
          advisorId: "adv_reyes",
          budgetTokens: 8000,
          now: NOW,
        },
        session,
      ),
    /belongs to adv_hartman/,
  );
});

test("a long session drops its oldest turns, not its newest", async () => {
  let session = newSession("sess_long", "adv_reyes");
  for (let i = 0; i < 40; i++) {
    session = recordTurn(session, {
      id: `long${i}`,
      role: i % 2 === 0 ? "advisor" : "assistant",
      text: `Turn number ${i}. ${"Discussion of the Harbor Point distribution timing. ".repeat(6)}`,
      clientId: "cl_whitfield_james",
      at: new Date(Date.parse("2026-08-27T08:00:00Z") + i * 60_000).toISOString(),
    });
  }

  const out = await compiler.compile(
    {
      task: "post-meeting-followup",
      clientId: "cl_whitfield_james",
      advisorId: "adv_reyes",
      budgetTokens: 4000,
      now: NOW,
    },
    session,
  );

  assert.ok(out.text.includes("Turn number 39"), "the newest turn must survive");
  assert.ok(!out.text.includes("Turn number 0."), "the oldest turn should be the one dropped");
});
