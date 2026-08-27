import { strict as assert } from "node:assert";
import { test } from "node:test";
import { makeCompiler } from "../src/compile.ts";
import { makeMockEmbedder } from "../src/embed.ts";
import type { CompileRequest } from "../src/types.ts";

const NOW = "2026-08-27T09:00:00Z";
const compiler = await makeCompiler({ embedder: makeMockEmbedder() });

function request(over: Partial<CompileRequest> = {}): CompileRequest {
  return {
    task: "meeting-prep",
    clientId: "cl_whitfield_james",
    advisorId: "adv_reyes",
    budgetTokens: 4000,
    now: NOW,
    ...over,
  };
}

test("the window never exceeds the budget it was given", async () => {
  for (const budgetTokens of [800, 1500, 2000, 4000, 8000, 16000]) {
    const out = await compiler.compile(request({ budgetTokens }));
    assert.ok(
      out.manifest.usedTokens <= budgetTokens,
      `used ${out.manifest.usedTokens} of ${budgetTokens}`,
    );
  }
});

test("one client's private detail does not reach another's window", async () => {
  // Osei's daughter's tuition lives on a thread Whitfield is also on.
  const out = await compiler.compile(request({ clientId: "cl_whitfield_james" }));
  assert.ok(!out.text.includes("tuition"));
  assert.ok(!/\bOsei\b/.test(out.text));

  // And it is present for the client it actually belongs to.
  const owner = await compiler.compile(request({ clientId: "cl_osei_james" }));
  assert.ok(owner.text.includes("tuition"), "Osei's own window should keep his tuition item");
});

test("every dropped candidate carries a reason", async () => {
  const out = await compiler.compile(request({ budgetTokens: 1500 }));
  const dropped = out.manifest.entries.filter((e) => !e.admitted);
  assert.ok(dropped.length > 0, "a 1500-token budget should drop something");
  for (const entry of dropped) {
    assert.ok(entry.admitted === false && entry.reason.length > 0);
  }
});

test("citations resolve to a source the manifest admitted", async () => {
  const out = await compiler.compile(request());
  assert.ok(out.citable.size > 0);
  for (const [key, ref] of out.citable) {
    assert.ok(out.text.includes(`[${key}]`), `window should carry ${key}`);
    assert.equal(`${ref.system}:${ref.kind}/${ref.id}`, key);
  }
});

test("an advisor cannot compile for a client outside their book", async () => {
  await assert.rejects(
    () => compiler.compile(request({ clientId: "cl_okonkwo_ngozi" })),
    /does not advise/,
  );
});

test("budget shares shift with the task", async () => {
  const briefing = await compiler.compile(request({ task: "daily-briefing" }));
  const compliance = await compiler.compile(request({ task: "compliance-review" }));
  assert.ok(
    compliance.manifest.layers.firm.tokens > briefing.manifest.layers.firm.tokens,
    "a compliance review should spend more on firm knowledge than a briefing does",
  );
});
