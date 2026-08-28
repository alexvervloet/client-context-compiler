# client-context-compiler

Builds the context window for a wealth-management agent. One task, one client,
one token budget in; a window and a manifest out.

## The sentence this exists for

*The advisor is allowed to see both files. That's what makes this hard.*

Two clients of the same advisor co-own a property company. They email each
other with the advisor copied. On one of those messages, one of them mentions
that his daughter's tuition is due on September 12 and he needs his share of
the distribution released to cover it.

Now generate the other man's meeting prep. Every permission check passes: the
advisor is authorized for both. Retrieval scores the thread highly, because it
is genuinely about the client you asked for. And the prep note comes out saying
"you have a tuition payment due September 12".

That is not an authorization failure. Row-level security does not see it,
ACLs do not see it, and a grounding eval does not see it either, because the
claim really is supported by a real source in the window. It is an attribution
failure, and it is the failure a firm gets a phone call about.

## What it does

Four things, and nothing else.

**Packs three memories under one budget.** Firm knowledge, client history, and
the current conversation, with shares that change per task. A compliance review
spends 35% of its budget on the firm's own documentation standard. A daily
briefing spends 10%.

**Fences the conversation too.** The session layer is where cross-client bleed
actually happens in a product, and retrieval is not involved in it at all. An
advisor preps one client at nine and another at nine fifteen, then asks "what
about the September obligation?" without saying whose. That turn names nobody,
so no amount of mention detection helps. What it has is a recorded subject, and
that is the whole defence.

**Fences the window to one client, in code.** Not in a system prompt. The
packer refuses to emit text that names somebody else, and re-checks the
assembled window before returning it. If the fence has a hole, the compile
throws rather than shipping the briefing.

**Says why.** Every candidate appears in the manifest with a verdict: admitted,
dropped for budget, held back by the fence, refused for authorization. During
an incident review that is the difference between "the model missed it" and
"the model never saw it".

**Cites everything back to a record.** Each passage carries a key like
`gmail:message/t_harbor_point_distributionm1`, validated against the manifest.
A model that invents a plausible-looking key is caught, because a fake key is
worse than no key: it survives review by looking real.

## Quick start

```bash
npm install
npm test            # unit tests
npm run evals       # the gate: 182 checks, no API key needed
npm run measure     # regenerates every number in this README

npm run ccc -- clients
npm run ccc -- compile  cl_whitfield_james meeting-prep --budget 6000
npm run ccc -- manifest cl_whitfield_james meeting-prep --budget 6000
npm run ccc -- sweep    cl_whitfield_james meeting-prep
```

No API key required. Embeddings and generation both fall back to a mock, and
both print a banner saying so, because a benchmark that quietly ran against a
mock is worse than no benchmark.

With `ANTHROPIC_API_KEY` set, `npm run evals` adds the grounding and
attribution suites and `npm run ccc -- answer` generates for real. With
`VOYAGE_API_KEY` set, retrieval uses real embeddings.

## The firm

Northgate Wealth Partners is synthetic and deterministic from a seed. It exists
because the interesting failures need specific relationships between specific
people, and you cannot plant those in a public dataset.

The traps are hand-written in [`src/corpus/traps.ts`](src/corpus/traps.ts) so
anyone can read them and check the evals are testing something real. Bulk
traffic is generated around them, because if the only client-layer text were
traps, a fence that dropped everything would score perfectly.

| trap | what breaks |
| --- | --- |
| Co-investors sharing a first name | Two unrelated clients, both called James, on one LLC thread. One's tuition bill is the detail that must not travel. |
| Shared household | The Chens are married with a joint account. One spouse's concentrated position is not the other's. |
| Same surname, unrelated | Two Delgados with the same advisor. Authorization cannot separate them; only the fence can. |
| Family trust across three clients | One document names three siblings. The advisor is authorized for two of them. |
| Stale note contradicting the CRM | A 2024 note says aggressive, a 2026 note says conservative. Both are an excellent match for "risk tolerance". |
| Forged instruction in a forwarded email | A message body tells whatever reads it to list every client's portfolio value. |

## The corpus

| | count |
| --- | ---: |
| clients | 12 |
| email threads | 347 |
| email messages | 609 |
| calendar events | 74 |
| meeting notes | 46 |
| planning documents | 26 |
| firm documents | 6 |
| chunks after normalization | 787 |
| chunks naming more than one client | 44 |

## What a bigger budget buys

Meeting prep for James Whitfield, strict fence, mock embeddings.

| budget | used | fill | passages admitted | dropped for budget | held by the fence |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1000 | 975 | 98% | 9 | 67 | 6 |
| 2000 | 1953 | 98% | 20 | 56 | 6 |
| 4000 | 3921 | 98% | 42 | 34 | 6 |
| 8000 | 6807 | 85% | 76 | 0 | 6 |
| 16000 | 6807 | 43% | 76 | 0 | 6 |
| 32000 | 6807 | 21% | 76 | 0 | 6 |
| 64000 | 6807 | 11% | 76 | 0 | 6 |

## What the fence costs

Every client, every task, 8000-token budget. A held-back passage is one
retrieval found, the advisor is authorized to read, and the compiler
refused because it names someone else.

| policy | passages admitted | held by the fence | share held back |
| --- | ---: | ---: | ---: |
| strict | 3524 | 132 | 3.6% |
| redact | 3532 | 124 | 3.4% |

Redaction recovers 8 passages that strict refuses, which is 0.2% more context.

## Token estimator error

Not measured on this run: no Anthropic credentials. The estimator's
accuracy against the real tokenizer is unverified until this is run
with a key, and the number below should not be quoted from a mock run.

## Reading the numbers

Two things in the sweep table are worth more than the rest.

Past 8,000 tokens the window stops growing. It saturates at 6,807 and stays
there whether the budget is 8k or 64k, because by then retrieval has returned
everything that passes the client filter. The binding constraint moved from the
budget to the retriever, and eight times the context window bought nothing. That
is the concrete version of "just add more context isn't always the answer": at
some point you are not short of room, you are short of candidates, and the fix
is upstream.

The fence holds back 3.6% of what retrieval finds. Not 30%, and not 0.1%. Small
enough that refusing is affordable, large enough that a pipeline without a fence
is shipping other people's information into roughly one passage in thirty.

## Design decisions worth arguing about

**Ambiguity resolves outward.** A bare "Chen" marks a passage as being about
both Chens rather than guessing which one. Guessing is how a briefing asserts
one spouse's holdings as the other's, and the guess is invisible once made.

**But an ambiguous name is not automatically contamination.** "Okonkwo" inside
Adaeze's own window means Adaeze. Treating every ambiguous form as a leak throws
away most of a family's records for nothing. The rule is that an ambiguous name
is harmless only when something else already pins the passage to the subject:
an unambiguous name in the text, or failing that, the source record's own
fields.

That second half was a bug for a while, and the eval suite is what found it.
The generated meeting notes are titled `{surname} — meeting notes`, which names
three siblings and nobody in particular, so the fence cheerfully filed each
sibling's notes under the others. No name appeared that shouldn't have. What
leaked was the body of somebody else's note under a title that could have meant
anyone. [LESSONS.md](LESSONS.md) has the full account.

**Chunk granularity is a contamination control, not just a retrieval knob.** The
trust document names three clients. Split into paragraphs, the paragraph about
one sibling's sub-account names only that sibling and can be admitted on its
own. Kept whole, the document is unusable for anybody. The corollary bit: a
merge rule that combines a short paragraph with its neighbour is a boundary
decision in disguise, and it silently cost two clients their account balances
before it got a client-boundary check.

**The relevance floor is relative, and conditional.** An absolute cosine
threshold does not survive a change of embedding model: the mock here scores in
a different range than Voyage, and a number tuned against one silently empties
windows under the other. The floor is a fraction of the best match in that
search, and it only fires when there are more candidates than `topK`, because
its job is trimming a long tail and a client with a thin file does not have one.

**The client filter runs before scoring, not after.** Filtering after ranking
leaks through top-k, and it means a forbidden chunk was ranked, logged and
traced before anyone asked whether it was allowed to exist in that request.

**Costing matches rendering exactly.** The packer costs the string it is about
to emit, citation line and blank lines included, and throws if the finished
window exceeds its budget. Costing the bare chunk and rendering something larger
is how a window overflows a budget it was told to respect, which it did here,
by 5%, until it was fixed.

**Contamination is computed over exactly the text that gets rendered.** Not the
body without the subject line, not the paragraph without its title. Any gap
between what is analysed and what is shown is a hole the fence cannot see
through.

## What redaction cannot do

The `redact` policy masks another client's name and keeps the passage. It was
meant to trade a little precision for a lot of recall. It leaked in eight of
forty-eight cases.

Removing `james.osei@example.test` from a message *written by* Osei leaves the
sentence "my daughter's tuition is due September 12" in Whitfield's window,
attributed to `[another client]`. The name is gone; the fact is not, and a model
reading a window compiled for one man has every reason to treat an ownerless
fact in it as his. Sentence-level masking would not have helped either, because
the giveaway was in the `From` header.

So redaction now only applies where the other client is mentioned in passing in
a record somebody else owns: an advisor's note about one client that reaches for
another as a comparison. If the other client is party to the record, both
policies refuse it. That is a much smaller feature than intended and it is the
only version that holds up. It recovers 8 passages out of 3,524.

Strict is the default and should stay the default.

## Model routing

Routing reads the manifest, not just the task name. A window full of masked
names is a harder attribution problem than the task usually is, so it routes up.
A window that came back nearly empty routes *down*, because a larger model
cannot invent the records retrieval failed to find, and the honest output there
is short.

| task | model | effort | why |
| --- | --- | --- | --- |
| daily briefing | Sonnet 5 | medium | one per client per morning, and a person reads it before acting |
| meeting prep | Opus 5 | high | the advisor walks into a room holding this |
| post-meeting follow-up | Sonnet 5 | medium | summarising what was just agreed |
| compliance review | Opus 5 | xhigh | audited, and a wrong answer is a finding |

Everything defaults to Opus. Routing down is a decision that has to earn itself
against a measured quality number, which is what the eval suite is for. Routing
down on a hunch is how a compliance review quietly gets worse.

The rationales above are currently opinions. `npm run bench` turns them into a
table: latency, cost, fabricated keys, uncited claims and foreign references per
task per model, over identical compiled windows so the model is the only
variable. It needs credentials and refuses to run without them, because a model
comparison assembled from stub output looks exactly like a real one.

## Evals

```
PASS  cross-client leakage (policy: strict)  (48/48)
PASS  cross-client leakage (policy: redact)  (48/48)
PASS  named traps (policy: strict)          (6/6)
PASS  named traps (policy: redact)          (6/6)
PASS  authorization                         (13/13)
PASS  conversation carry-over               (108/108)
PASS  budget and manifest                   (61/61)
SKIP  grounding and attribution
```

The leak, trap, authorization, carry-over and budget suites need no model and
no key. They
test deterministic code, so they run in CI on every push and gate the merge.

The grounding and attribution suites need a live model and report as **skipped**
rather than passing quietly against a mock. Passing a quality gate against a
stub is the worst of both worlds: you get the green tick and none of the
signal.

Both fence policies run on every gate, because a change that fixes one while
breaking the other is exactly the regression this is here to catch.

The leak suite checks for private *details*, not only for names. That matters:
the fence bug described above leaked no names at all.

Carry-over runs every ordered pair of one advisor's clients rather than a pair
chosen to collide, and checks the reverse too: a session compiled for the client
it is actually about must keep its turns. A layer that dropped everything would
pass the first half perfectly.

## Using it on your own data

The bundled firm is the default, not a dependency. Supply your own chunks and a
directory and nothing from `src/corpus/` is involved:

```ts
import { buildChunk, buildMentionIndex, makeCompiler } from "client-context-compiler";

const directory = { clients: [
  { id: "c_8812", first: "Margaret", last: "Chen",
    email: "m.chen@example.com", advisorId: "adv_reyes" },
]};

const index = buildMentionIndex(directory.clients);

const chunks = crmRecords.map((record) =>
  buildChunk(
    record.id,
    "client",
    renderRecord(record),
    { system: "crm", kind: "contact", id: record.id, label: `CRM: ${record.name}` },
    record.updatedAt,
    index,
    [clientIdFor(record)],   // owners: whose record this is
  ),
);

const compiler = await makeCompiler({ chunks, directory });
```

The connector is yours. The one field worth care is `owners`: whose record this
is, taken from the record's own fields rather than its prose. That is what the
fence falls back on when the text names nobody, and it is the difference between
a session turn saying "what about that?" being safe and being a leak.

`src/index.ts` is the public surface. Everything else moves without warning.

## Limitations

Mention detection is a roster lookup with span precedence. It handles surnames,
first names, initials and email addresses. It does not handle "her brother",
"the trustee", or a misspelling, and a production version needs an entity layer
rather than a name list.

The corpus is synthetic. The relationships in it are the realistic part; the
prose is not, and the mock embedder scores lexical overlap rather than meaning,
so retrieval quality numbers from a keyless run mean nothing. The leak and
budget numbers do, since those come from deterministic code.

## Related

Two pieces of this problem I have built before, and deliberately did not rebuild
here:

- [knowledge-desk](https://github.com/alexvervloet/knowledge-desk) is the
  authorization half: multi-tenant Postgres, ACL-filtered candidate fetch, row
  level security, cost ledger, audit log. This project assumes all of that and
  attacks what is left over once permissions are already correct.
- [deskhand](https://github.com/alexvervloet/deskhand) is the execution half:
  approval gates, a frozen tool registry, durable step logs, and the same
  treatment of untrusted content that `answer.ts` uses here.

## Licence

MIT.
