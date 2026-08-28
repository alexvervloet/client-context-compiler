# Level 5: the senior AI engineer

You have shipped retrieval systems. You know what a reranker costs, why your
chunker is the way it is, and what happens to your eval suite the week after a
model deprecation. You do not need RAG explained.

So this is a design review. What the interesting decisions were, which ones I
think are right, which are wrong, and what an outside audit found that the
author's own 290-check suite did not.

## The claim

Given a task, a subject client, an advisor, and a token budget, produce a context
window that satisfies two invariants at the boundary rather than in expectation:

1. The rendered window contains no reference to any client other than the
   subject, where "reference" is a roster-resolvable name, initial form, or email
   address.
2. The rendered window fits the budget, measured against the string that will
   actually be emitted.

Both raise on violation. Neither is a prompt instruction.

The interesting part is not the mechanism, which is straightforward, but the
threat model. This is **attribution**, not authorization, and it sits in a gap
between two mature disciplines. Row-level security passes. Grounding evals pass.
The claim is real, cited, and about the wrong principal.

Concretely: two clients of one advisor co-own an LLC, email each other with her
copied, and one mentions his daughter's tuition due September 12. Compile the
other man's meeting prep. Every control says yes and the output is a disclosure.

I have not found off-the-shelf tooling for this. The nearest neighbours are
tenant isolation, which is the wrong granularity because the advisor is
authorized for both, and PII detection, which is the wrong question because the
information is not sensitive in itself, only misattributed.

## Design decisions, with the arguments

### Provenance strictly dominates prose, and the ordering is load-bearing

Every chunk carries two independent answers to "who is this about":

```ts
/** Every client this chunk could concern. The coarse view, used for filtering. */
clients: ClientId[];
/** Who the source record belongs to, from its own fields rather than its prose. */
owners: ClientId[];
mentions: Mention[];
```

`mentions` comes from scanning rendered text. `owners` comes from structural
fields: `From`/`To`/`Cc`, attendee lists, the CRM row's client id, and for a
session turn the subject recorded at the time the turn happened.

Neither derives from the other. A trust document addressed to two siblings
discusses a third, which only prose catches. A meeting note titled
`Okonkwo, meeting notes` names three people and nobody, which only the attendee
list resolves.

The precedence rule: **provenance is authoritative and no phrasing inside a
record changes whose record it is.** A note in Elena's file reading "For Margaret
Chen: the deposit must clear before closing" is still Elena's note and still
carries Elena's numbers.

In `fence.ts` that is an ordering constraint, and it is commented as one:

```ts
// Provenance is authoritative, and this check has to come before any
// reasoning about the prose.
const foreignOwners = chunk.owners.filter((c) => c !== subject);
if (chunk.owners.length > 0 && !chunk.owners.includes(subject)) {
  return { action: "refuse", reason: "other-client-only", offending: foreignOwners.sort() };
}
```

It used to come after. An external auditor found the leak. More on that below,
because the *reason* the tests missed it is the most transferable thing here.

### Ambiguity widens; anchoring narrows it back

Mentions carry candidate sets, not resolved ids:

```ts
export type Mention = {
  form: string;
  start: number;
  end: number;
  candidates: ClientId[];
};
```

A bare "Chen" is both Chens. Widening is recoverable and guessing is not: the
moment a resolver picks one, nothing downstream can distinguish a resolved
reference from a guessed one, and a guess is how a briefing asserts one spouse's
holdings as the other's.

But treating every ambiguous form as contamination throws away most of a family's
records. "Okonkwo" inside Adaeze's own window almost certainly means Adaeze.

The rule that splits it: **an ambiguous mention is harmless only when something
else already pins the chunk to the subject.**

```ts
const resolved = new Set<ClientId>();
for (const mention of chunk.mentions) {
  const only = mention.candidates.length === 1 ? mention.candidates[0] : undefined;
  if (only !== undefined) resolved.add(only);
}
const anchors = resolved.size > 0 ? resolved : new Set(chunk.owners);
const anchoredToSubject = anchors.has(subject);
```

Anchor precedence: an unambiguous name in the text wins; `owners` is the
fallback; nothing means refuse with `unanchored`.

Note what `resolved.size > 0 ? resolved : owners` actually says. If *any*
unambiguous name is present, owners are ignored for anchoring. That is
deliberate, and it is also where the audited bug lived when the whole check ran
in the wrong order. It survives now only because the hard provenance refusal
above it already eliminated foreign-owned chunks. The two rules are coupled and
the file does not make that coupling as explicit as it should.

### The client filter precedes scoring

```ts
if (!servesSubject(chunk, options.subject)) continue;
const similarity = cosine(queryVector, vector);
```

```ts
export function servesSubject(chunk: Chunk, subject: ClientId): boolean {
  if (chunk.layer === "firm" && chunk.clients.length === 0) return true;
  if (chunk.owners.length > 0 && !chunk.owners.includes(subject)) return false;
  return chunk.clients.includes(subject);
}
```

Post-filtering leaks through top-k and, more importantly, means a forbidden chunk
was scored, logged and traced before anyone asked whether it belonged in the
request. In an audited environment that trace is itself a finding.

Cost note for anyone porting this: pre-filtering fights ANN. At 787 chunks the
linear scan is free. At scale you need metadata-filtered ANN or per-tenant
partitions, and the honest position is that filtered HNSW recall degrades when
the filter is selective, so you may end up with per-client subindices and a
memory bill. `servesSubject` making the effective corpus per-client rather than
per-firm buys a lot of headroom before that bites, which is a nice accident of
the design rather than something it was built for.

### Costing matches rendering, and the assertion is on the render

```ts
const cost = estimateTokens(renderRecord(record));
```

The packer costs the exact string it is about to emit, citation line, caveat
suffix and leading newlines included. Costing the bare chunk and rendering the
decorated version overflowed a budget by 5% before it was fixed.

There is a small elegance in `renderRecord`: every piece starts with whitespace,
so `estimateTokens(parts).sum() === estimateTokens(whole)`. Additive costing is
what lets the greedy loop be correct without re-rendering the whole window per
candidate.

Scaffold reservation happens up front, and a budget below the scaffold throws a
message that says so rather than emitting a degenerate window:

```ts
`a budget of ${request.budgetTokens} tokens is below the ${scaffold} the window ` +
  "header and layer headings cost before any content. Raise the budget; " +
  "nothing has drifted."
```

I like that error text. It pre-empts the debugging session the caller was about
to start in the wrong place.

### Greedy, not DP

Sorted by blended score, filled per layer, first fit. The defence:

The objective is a heuristic (`similarity * 0.65 + recency * 0.35`). Solving a
knapsack exactly against an approximate value function optimises the wrong thing
precisely.

Order carries information. Relevance-descending puts the important material where
attention is most reliable. A DP-optimal packing reorders for fit and loses that.

And the manifest has to be readable by a compliance officer. "It scored higher,
so it went first, and by your turn there were 40 tokens left" is explainable. A
DP table is not.

Layer quotas by task exist because a single global ranking lets the client layer
win everything, since a client's own email always out-scores a firm policy
document on a query about that client. For a compliance review whose entire
purpose is checking the file against the documentation standard, that is a task
failure composed entirely of relevant chunks.

## Negative results, which are the valuable half

### Redaction does not contain a shared record

The `redact` policy masks foreign names and keeps the passage. The hypothesis was
a favourable precision-for-recall trade.

**It leaked in 8 of 48 cases.**

Removing `james.osei@example.test` from a message *written by* Osei leaves the
sentence "my daughter's tuition is due September 12" in Whitfield's window,
attributed to `[another client]`. The identifier is gone. The information is not,
and a model reading a window compiled for one man has every reason to treat an
ownerless fact in it as his.

Sentence-level masking would not have helped. The giveaway was in the `From`
header, not in the sentence.

So redaction is now scoped to a client mentioned *in passing* in a record
somebody else owns, typically an advisor's note reaching for one client as a
comparison. If the other client is party to the record, both policies refuse:

```ts
if (foreignOwners.length > 0) {
  return { action: "refuse", reason: "shared-record", /* ... */ };
}
```

Then the second finding, which is the one I would lead with in a design review:
**it does not pay for itself either.**

| policy | admitted | held by fence | share held |
| --- | ---: | ---: | ---: |
| strict | 3,620 | 132 | 3.5% |
| redact | 3,628 | 124 | 3.3% |

Eight extra passages out of 3,620. **0.22% more context.** And at an 8,000-token
budget redaction admits *one fewer* than strict, because `[another client]`
costs 10 estimated tokens against the six or seven of the names it replaces, so a
redacted passage crowds out a clean one.

The whole feature is a rounding error that sometimes costs recall. It stays only
because the policy axis catches fence regressions in the eval matrix, and because
the measurement is the point: **masking an identifier is not removing the
information, and it is not free.**

Generalise it before you build your own PII redaction layer. Ask what fraction of
the leak the identifier actually carries. For anything authored by the person
being protected, the answer is close to zero.

### The estimator was inverted, and the fix is still wrong

The original comment:

> The estimator is deliberately biased to overcount. An overcount wastes a little
> budget; an undercount overflows the window, and an overflowed window fails at
> request time in front of a user.

Correct reasoning. Measured against `count_tokens`:

| | raw model |
| --- | ---: |
| mean relative error | -15.6% |
| worst | -29.5% |
| undercount rate | **100%** |

Never once overcounted. Every `usedTokens <= budgetTokens` assertion in the
packer had been passing for weeks against the wrong ruler.

Root cause, one line: `letters = word.length - symbols` folded digits in with
letters at 1/3.4. BPE groups digit runs far more tightly, and the corpus is
dates, dollar amounts, account numbers and addresses.

Two-part fix. Structural:

```ts
const LETTERS_PER_TOKEN = 3.4;
const DIGITS_PER_TOKEN = 2;
tokens += symbols
        + Math.ceil(digits / DIGITS_PER_TOKEN)
        + Math.max(letters > 0 ? 1 : 0, Math.ceil(letters / LETTERS_PER_TOKEN));
tokens += (text.match(/\n/g) ?? []).length;
```

Plus an explicit margin derived from the measurement rather than chosen:

```ts
const SAFETY_MARGIN = Number(process.env["TOKEN_SAFETY_MARGIN"] ?? 1.3);
```

Structural fix alone closed the gap to about 1.17x; clearing the worst observed
-29.5% needs about 1.30x. Re-measured: mean -2.9% raw, and the shipped estimator
undercounts on **0%** of samples, which is the property the assertion depends on.

Now the part that is still wrong, and it is a nice methodological error.

The shipped estimator overcounts by **26.8% on average**. The margin was set to
cover the worst *chunk*, but the invariant is a property of the whole *window*,
across which hundreds of chunk errors average out. Setting a per-window margin
from per-chunk tail error is a scope mismatch, and it is currently costing about
a fifth of every window's capacity. `npm run measure` now reports window-level
error; the margin should be derived from that. Not done.

There is a correct-by-construction escape hatch for anyone who wants the property
rather than the belief:

```ts
makeCompiler({ verifyBudget: true })
```

One `count_tokens` per compile against the finished window. Off by default
because it is on the request path. Worth it in a canary. The error message tells
you what to do:

```
window is N real tokens against a budget of B. The estimator said E, so it is
running low. Raise TOKEN_SAFETY_MARGIN and re-run npm run measure.
```

A detail that bit once: `measureEnvelopeTokens` subtracts the message wrapper
before comparing, and it uses `rawEstimate` rather than `estimateTokens`, because
measuring the envelope with the margin applied makes the constant used to grade
the margin a function of the margin. It is also cached per model per process,
because it was previously re-measured on every call, so `verifyBudget: true` cost
two round trips per compile rather than the one it advertised.

### Filter constants encode a model's score distribution

`if (similarity < 0.02) skip` was two bugs.

Absolute, so it encodes one embedding model's range. The mock and Voyage do not
share a distribution; a threshold tuned on either is wrong for the other, with no
error to signal it.

And unconditional, including for a client whose whole file is four records, where
there is no tail to trim and the result is an empty window.

```ts
const applyFloor = scored.length > topK && best > 0;
const floor = best * relativeFloor;   // 0.15
```

The test that caught it is worth stealing: run the compiler against a *different,
tiny* firm through the public API. Four records, a mock embedder, and assert the
obviously-correct record is in the manifest. That test exists for API-shape
reasons and it caught a retrieval bug, because a four-record corpus enters
branches an 800-chunk corpus never will.

## The audit, and what it says about eval suites

An independent agent with no history of building this repository attacked it. It
found a real leak, refuted two of the eight claims the README makes, and showed
that four safety mechanisms could be deleted with every test still green.

### The bug

A session turn recorded as client A's, whose text names client B, was admitted
into B's window carrying A's numbers. The fence resolved "whose passage is this"
from prose first and `owners` only as a fallback, so any chunk naming someone
unambiguously had its provenance discarded.

Client records were shielded, because `servesSubject` checks owners
independently during retrieval. **Conversation turns never go through retrieval,
so the fence was their only gate.** Defence in depth hid the hole everywhere
except the one path with a single layer.

That is a general shape worth naming: when two independent checks enforce the
same property and one of them is buggy, the bug is invisible until you find the
path that only has one.

And the meta-observation, which the author writes down himself:

> The entry three sections above this one already states the correct rule. I
> wrote that down and then implemented the opposite precedence one commit later.
> Writing a lesson down is not the same as applying it, and a repository that
> documents its own reasoning can read as more trustworthy than it is.

### Why 108 test cases were one test case

The carry-over suite runs every ordered pair of one advisor's clients across
every task. 108 cases. It is the suite that most directly targets the bug's
location, and it missed it.

Look at the fixtures:

```ts
const PRIOR_ANSWER: Record<string, string> = {
  cl_chen_margaret: "She has reversed her 2024 position and the muni ladder...",
  cl_chen_david:    "The concentrated position in his consulting LLC escrow...",
  cl_okonkwo_chidi: "He is deferring to November with no stated use...",
};
```

Every prior answer is phrased in pronouns or the owner's own name. **Not one
names a different client.**

The anchor rule has two arms. All 108 cases exercise the owners-fallback arm. The
bug was in the prose-wins arm, which zero cases touched.

The generalisation is the important part: **the tests were written from the same
mental model as the code**, so they cover the branch the author was thinking
about and skip its complement. Cross-product volume does not fix this, because
the product is over the wrong dimension. 108 cases of one shape is one case.

Practical rule: for any rule with two arms, hand-write the case for each arm and
label it as such. Generated volume is for finding interactions, not for covering
branches.

### Mutation testing, and the number that should worry you

Fourteen single-line mutations. **Ten survived the full 290-check suite. Five
survived the unit tests as well.**

Deletable with everything green:

- the client pre-filter in retrieval, entirely
- the `unanchored` refusal branch
- the fence policy, pinned to one value
- the redaction mask, set to the empty string

Diagnosis: the suite was testing the corpus, not the code. A corpus-driven suite
only reaches branches the bundled data happens to enter, and iterating harder
over that corpus does not change which branches those are. It is the same failure
as the carry-over suite, one level up.

Mutation testing is cheap, it needs no infrastructure, and it measures the thing
line coverage pretends to. If your project's central claim is a safety property
and you have not mutated it, you do not know what your suite catches. I would put
this above almost any other testing investment for a system like this.

## Eval design: two categories, and only one of them is cheap

Sort every check into:

**Compare against a known set.** Does this citation key exist in
`context.citable`? Does this window contain a name resolving to a non-subject
client? Does this private detail appear? Exact-match, deterministic, no false
positives, effectively free, runs in CI.

**Parse the output's shape.** Does every sentence carry a citation? Is this
statement an assertion or a statement of absence?

From LESSONS.md, on the second kind:

> It found my parser, three times running. First it flagged metadata lines and
> statements of absence. Then it split inside quotations and demanded a citation
> after every sentence, which is not how cited writing works. Then it flagged a
> bold-only sub-heading and a list lead-in ending in a colon. Every failure was a
> formatting artifact. The model never once asserted something it could not cite.

Meanwhile the exact-match checks in the same suite passed on the first live run
and have not been touched since. The difference is not difficulty. It is that a
key either exists in the manifest or it does not, and neither check asks a regex
to understand prose.

Shape parsers still earn their keep. This one caught the model opening every
briefing with a preamble restating when the context was compiled, which was a
real product bug fixed in the prompt. Just budget for the maintenance and give
the parser its own unit tests on day one, not after three rounds of false
failures. The repository now has `tests/attribution.test.ts` doing exactly that,
and a single shared implementation after the bench was found running its own
stale copy and reporting a formatting artifact as a quality metric.

### Skip, do not pass, against a mock

```ts
meaningfulOffline: true | false
```

```
PASS  cross-client leakage (policy: strict)  (48/48)
PASS  conversation carry-over                (108/108)
SKIP  grounding and attribution
```

Passing a quality gate against a stub is the worst of both worlds. You get the
green tick and none of the signal, and the tick suppresses the question. The mock
embedder and mock generator both print a stderr banner saying results from them
are not publishable, and `EMBEDDINGS_STRICT=1` turns the fallback into an error
for CI paths that must not run mocked.

## Routing, and the reasoning error worth naming

```ts
if (manifest.usedTokens < manifest.budgetTokens * 0.1) {
  return { model: "claude-haiku-4-5", effort: "low", rationale: "..." };
}
const share = redacted / admitted.length;
if (share > CAVEAT_ESCALATION) return { model: oneTierUp(base.model), /* ... */ };
```

Routing on manifest shape rather than task name is the right instinct. A window
with a high share of masked names is a harder attribution problem than the task
usually is. A nearly-empty window routes **down**, because a larger model cannot
invent records retrieval failed to find and the honest output is short.

Two bugs found in that small function are instructive out of proportion to its
size.

**A guard on the wrong scope.** `if (admitted.length === 0) return base;` was
meant to protect a division. It returned from the whole function, so the
route-down rule below it never fired in the emptiest case there is. Dead since it
was written, and nothing noticed, because **routing has no wrong answer that
throws.** Every branch returns something plausible. Found by a unit test written
for something else.

Rule: put a guard around the expression it protects, not around everything after
it. And a decision function whose every branch returns something plausible needs
a test per branch, because there is no failure to observe.

**A request surface is a capability, not a constant.** `answer.ts` sent
`thinking: {type: "adaptive"}` and `output_config: {effort}` on every call.
`claude-haiku-4-5` returns `400 invalid_request_error`, not a silent ignore.
Adaptive thinking and effort arrived with the 4.6 family.

This surfaced in the bench, which is the only place naming models explicitly, and
it read like a bench problem. It was not. The router drops to Haiku on a thin
window, so the live path could build the same unsendable request. It had never
fired because that route was also broken, which is the previous bug.

Now the route carries intent and a capability table decides expressibility:

```ts
export const CAPABILITIES: Record<ModelId, ModelCapabilities> = {
  "claude-opus-5":    { adaptiveThinking: true,  effort: true },
  "claude-sonnet-5":  { adaptiveThinking: true,  effort: true },
  "claude-haiku-4-5": { adaptiveThinking: false, effort: false },
};
```

`buildRequestParams` is exported so the shape can be asserted per model without
spending a request. When you add a model to a routing table, write the capability
row at the same time as the pricing row.

### The defaults argument

The table was originally Opus everywhere, justified as "routing down has to earn
itself against a measured quality number."

The flaw: routing *up* was not held to the same standard. With the bench unrun,
Opus everywhere was exactly as unmeasured, and it was the expensive kind of
unmeasured. **Cost is known in advance; quality is not.** Defaulting to the
known-cheap option while the quality question is open is the reversible choice.

The table is marked provisional in the README until the findings suite runs. I
would rather read that than a confident table.

## Cost control as a first-class component

`spend.ts` exists because it was missing. Twelve uncapped calls at Opus rates,
`effort` forced high, `max_tokens: 16000`, adaptive thinking billing reasoning as
output. Projected worst case, computed afterwards: $2.89 a run. The thing that
objected was the account running out of credit.

```ts
const projected = projectWorstCaseUsd(route.model, inputTokens, params.max_tokens);
budget.authorize(projected, `${task} on ${route.model}`);
// request
budget.record(costUsd);
```

**Authorize before using the worst case the request permits; record after using
actual.** After is accounting, before is a control. Projecting from a typical
call makes the cap an estimate rather than a ceiling.

Three details that generalise:

Per-task output ceilings rather than one generous constant. With adaptive
thinking, `max_tokens` is thinking room billed at the output rate, so headroom is
not free. Same eight calls, same coverage, $2.89 to $0.35.

The gate must precede the *first* paid call, not the first interesting one. It
originally sat after index construction, so a dry run embedded 787 chunks through
a paid API and then printed "Dry run. No network calls have been made." Embedding
also had no ledger at all, in the module that exists because an uncapped loop
emptied an account. `SPEND_CAP_USD` would not have stopped it at any value.

Cache anything deterministic. Embeddings are cached on disk keyed by model name
and content hash, so changing the model and editing a chunk both miss correctly.
The corpus is seeded and identical, and it was being re-embedded on every run of
the evals, the measurement script and the bench.

## Measured behaviour

Window saturation, meeting prep, strict fence:

| budget | used | fill | admitted | dropped for budget | held by fence |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 934 | 93% | 5 | 71 | 6 |
| 8,000 | 7,881 | 99% | 57 | 19 | 6 |
| 16,000 | 10,220 | 64% | 76 | 0 | 6 |
| 64,000 | 10,220 | 16% | 76 | 0 | 6 |

Saturation at 10,220 tokens. Past 16k the binding constraint moves from budget to
retriever, and 4x the window buys nothing. The concrete version of "more context
is not always the answer": at some point you are short of candidates, not room,
and the fix is upstream.

Note that `held by fence` is constant at 6 across every budget. The fence refuses
the same passages regardless of space, which is the correct behaviour and also
why the *share* metric moved from 3.5% to 4.4% at a tight budget with nothing
having changed. The denominator was admitted passages. That definition is fixed;
a metric that moves when the thing it measures did not is worth catching before
you quote it.

Fence cost across all clients and tasks at a non-binding budget: **132 of 3,752
passages, 3.5%.** Small enough that refusing is affordable, large enough that a
pipeline without a fence ships other people's information in roughly one passage
in thirty.

Live bench, real Voyage embeddings, real generation, eight calls, $0.16:

| task | model | p50 | in | out | cost | fabricated | foreign |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| daily briefing | Haiku 4.5 | 6.9s | 7033 | 418 | $0.0091 | 0 | 0 |
| meeting prep | Sonnet 5 | 14.6s | 8740 | 1422 | $0.0317 | 0 | 0 |
| compliance review | Haiku 4.5 | 5.1s | 7341 | 288 | $0.0088 | 0 | 0 |
| compliance review | Sonnet 5 | 26.3s | 9622 | 2605 | $0.0453 | 0 | 0 |

Zero fabricated keys, zero foreign references, on every task, both models,
including the window carrying the forged instruction.

### The column that is not there

Haiku's compliance review: 288 output tokens. Sonnet's: 2,605. Both perfect on
every column.

Every column is a safety property, and **a model scores perfectly on all of them
by writing almost nothing.** The table supports "Haiku is 60% cheaper and invents
nothing" and does not support "route compliance reviews to Haiku", which is a
claim about whether it *found* what the window contained.

If your suite has no metric that punishes silence, it has a hole shaped exactly
like your cheapest model, and cost pressure will walk you into it while the
dashboard stays green.

`evals/findings.ts` is the intended fix: per task, a handful of specific things
the window supports that a competent answer should surface. The 2024 note
contradicting Margaret Chen's current risk rating. The KYC date. The closing that
collides with a client's travel. The forged instruction flagged rather than
followed. **Each is verified present in the compiled window before it counts**,
so a miss is the model skipping what it was shown rather than retrieval failing.
That last property is what makes it a generation metric rather than a pipeline
metric, and it is the detail most findings-style evals get wrong.

Unmeasured as of writing. The README says so, and says the routing defaults are
therefore a cost decision rather than a quality one.

## Where this design is wrong or incomplete

Stated plainly, because a design review that only lists strengths is marketing.

**Mention detection is a roster lookup.** Surnames, first names, initial forms,
email addresses, with span precedence. It does not handle "her brother", "the
trustee", "my business partner", a name changed by marriage, or a misspelling. A
passage that reaches another client only through those routes gets through, and
the audit demonstrated it. What holds underneath is provenance: a record belongs
to whoever the source system says it belongs to. That is a real backstop for
owned records and no backstop at all for prose about a third party who is never
named.

A production version needs an entity layer: NER, coreference resolution, and a
relationship graph so "her brother" resolves. Each of those is probabilistic,
which means the fence's guarantee degrades from "exact string match against a
roster" to "recall of an NER model", and the honest framing then becomes a
measured false-negative rate rather than an invariant. That is a materially
different claim and the README should say so more loudly than it does.

**No fuzzy or transliterated matching.** `Margret` for `Margaret` is invisible.
Cheap partial fix with a real precision cost.

**Single-process, in-memory index, linear scan.** Fine at 787 chunks. The path to
`10^6` per firm is metadata-filtered ANN or per-client subindices, and the
pre-filter design makes the second viable.

**The safety margin is derived at the wrong scope.** Per-chunk tail error setting
a per-window margin, costing about 20% of capacity. Known, unfixed.

**The findings column is unmeasured**, so every routing default is a cost
decision wearing a quality argument's clothes. Explicitly labelled, which is the
minimum.

**Session subject is trusted input.** `Turn.clientId` is recorded by the caller.
The fence is exactly as good as the caller's honesty about which client a turn
was about. That is the right layering, and it is an unstated assumption in the
public API that deserves a paragraph in `index.ts`.

**The corpus is synthetic.** The relationships are the realistic part; the prose
is not. Leak and budget numbers come from deterministic code and hold. Retrieval
quality numbers from a mock run mean nothing, and the code shouts that on stderr.

**Mutation coverage is now known to be weak** and only partially repaired. Ten of
fourteen mutations survived. I would want that number published in the README
next to the "290 checks" figure, because 290 checks and 4/14 mutation kill rate
are two very different repositories and only one of those numbers is currently
visible.

## What I would take from this into a real system

Carry provenance as a first-class field and give it strict precedence over
anything derived from prose. Order the checks so provenance runs first, and write
the ordering constraint down as a comment, because it will look reorderable to
the next person.

Widen ambiguity into candidate sets and resolve it with an explicit anchor rule.
Never let a resolver silently pick.

Treat chunking as an access-control decision. Audit every merge, split, overlap
and summarisation for what it does to admissibility, not only to recall.

Cost the string you emit, assert on the finished artifact, and raise rather than
degrade.

Emit a manifest with a reason per rejection. It is the difference between "the
model missed it" and "the model never saw it" during an incident, and you cannot
reconstruct it afterwards.

Validate citations against a known set. Fabricated keys survive human review
precisely because they look real.

Authorize spend before the call using the worst case the request permits, place
the gate before the first paid call rather than the first interesting one, and
cache anything deterministic.

Split evals into compare-against-known-set and parse-the-shape. Gate on the
first, budget maintenance for the second, unit test the second from day one.

Report `SKIP` rather than `PASS` when a suite ran against a mock.

Mutation test before claiming a suite catches regressions. And get someone who
did not build the thing to attack it, because the author's tests and the author's
bugs come from the same place.

---

Previous: [the engineering manager](4-engineering-manager.md). Back to
[the index](README.md).
