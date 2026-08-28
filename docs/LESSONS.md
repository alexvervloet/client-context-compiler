# Lessons

Things that did not go the way the plan assumed. Written when they happened.

## Name matching inside an email address quietly poisons every chunk

**Expected:** detecting which clients a chunk is about would be a matter of
scanning for names, longest form first, with a whole-word boundary.

**What happened:** `ngozi.okonkwo@example.test` matched the bare surname rule
for "Okonkwo", so a message addressed to one sibling was labelled as being
about all three. The word boundary did not help, because `.` and `@` are not
word characters, so `\bokonkwo\b` matches happily inside an address.

The damage would have been invisible. Nothing throws. Every chunk just quietly
picks up extra clients, the fence sees contamination everywhere, and the packer
drops good material for a reason that looks principled in the manifest. The
only reason it surfaced was a test that asserted an exact client list rather
than "contains the client I expected".

**Next time:** resolve identifiers before names, and let the more specific
match consume its characters so the looser rule cannot see them. More generally,
assert the whole set in tests for this kind of extraction. `assert(found
.includes(x))` would have passed.

## Paragraph merging is a contamination decision wearing a formatting costume

**Expected:** merging short paragraphs into their neighbour was tidying. A
two-line heading has no business being its own chunk.

**What happened:** in the trust document, the paragraph about one sibling's
sub-account is 92 characters, so it merged forward into the paragraph about the
next sibling. The resulting chunk named two clients and was therefore
admissible for neither. Both siblings lost their own account balance from every
window, and the manifest said "cross-client", which is true and completely
unhelpful.

The rule now refuses a merge whenever it would put a second unambiguously named
client into the passage. Length still decides whether a merge is *wanted*;
client boundaries decide whether it is *allowed*.

**Next time:** any transformation that changes what text sits next to what
other text is a boundary decision. Splitting, merging, windowing, overlap,
summarising several records into one. Ask what a chunk is admissible for before
tuning it for retrieval quality.

## The fence had the exact bug the project was built to catch

**Expected:** treating an ambiguous name as harmless when the subject is one of
the candidates. "Okonkwo" inside Adaeze's window means Adaeze, so admit it and
move on. That reasoning is fine and I still think it is right.

**What happened:** the generated meeting notes are titled `{surname} — meeting
notes`. For three siblings, that title names all three and nobody in
particular. A note whose only client signal is that title is therefore
"ambiguous, includes the subject" for every sibling, so the fence admitted
Chidi's notes into Adaeze's window, Adaeze's into Chidi's, and both into each
other's for every task. Same for the two Chens, same for the two Delgados.

The eval suite caught it on the first run. Nothing else would have: no name
appeared that shouldn't, so a name-based check passed. What leaked was the
*body* of someone else's note under a title that could have meant anyone. The
only reason it surfaced is that the suite checks for private details, not just
for names, and those details were planted for that purpose.

The root cause was upstream. Normalization computed which clients a chunk was
about purely from its rendered text, and threw away the source record's own
fields. A meeting note has an attendee list. An email has a From header. Those
answer "whose file is this" when the prose refuses to.

The rule now: an unambiguous name in the text is the anchor when there is one,
and the record's own metadata is the anchor when there is not. An ambiguous
name is harmless only when something else already pins the passage to the
subject.

**Next time:** an invariant enforced only over rendered text can only see what
the text says. Provenance is a separate signal and it has to be carried, not
re-derived. And write the eval that looks for the *content* that must not
travel, not only the names.

## Redaction does not contain a shared record, and the numbers said so

**Expected:** a `redact` policy that masks another client's name would let
shared records into the window safely, trading a little precision for a lot of
recall. Strict would drop the whole Harbor Point thread; redact would keep it
with the other man's name blanked.

**What happened:** it leaked in eight of forty-eight cases. Masking
`james.osei@example.test` out of a message *written by* Osei leaves the
sentence "my daughter's tuition is due September 12" sitting in Whitfield's
window attributed to `[another client]`. The name is gone. The fact is not, and
a model reading a window compiled for one man has every reason to treat an
ownerless fact in it as his.

Sentence-level masking would not have helped either: the giveaway was in the
`From` header, not in the sentence.

Redaction now only applies to a client mentioned *in passing* in a record
somebody else owns. If the other client is party to the record, it is refused
under both policies. That is a smaller feature than intended and it is the only
version of it that holds.

**Next time:** "remove the identifier" is not the same as "remove the
information", and for anything authored by the person being protected it is not
close. Measure the containment claim before shipping the policy that depends on
it.

## An absolute similarity threshold does not survive changing the embedder

**Expected:** a `minSimilarity` floor of 0.02 was a harmless guard against
stuffing the window with junk.

**What happened:** it silently emptied a window. Writing a test that ran the
compiler against a different, tiny firm through the public API, four records
and a mock embedder, the record that obviously should have been retrieved was
not in the manifest at all. Not dropped for budget, not held by the fence.
Filtered before packing ever saw it.

Two separate mistakes in one line. The number was absolute, so it encoded the
score distribution of one specific embedding model; the mock and Voyage do not
share a range, and a threshold tuned against either is wrong for the other.
And it applied unconditionally, including to a client whose whole file is four
records, where there is no long tail to trim and nothing to gain by trimming.

Now the floor is a fraction of the best match in that search, and it only fires
when there are more candidates than `topK`.

**Next time:** any tuned constant that touches model output should be relative
to something observed in the same call, not absolute. And a knob that can
return zero results deserves a test that would notice, which is what the
different-firm test turned out to be.

## Batched output made a working eval run look like a hang

**Expected:** the eval runner collected results and printed a report at the
end. Offline that is a five-second wait and reads fine.

**What happened:** the first person to run it with credentials saw the npm
header and then nothing, and reasonably concluded it had frozen. It had not.
The live suite embeds the whole corpus and then makes six model calls with
adaptive thinking at high effort, and every one of those minutes produced no
output at all, because the runner had nothing to say until the last suite
finished.

Two things were wrong underneath the silence. `fetch` has no default timeout,
so a stalled embedding request would genuinely hang forever with no error. And
the Anthropic SDK defaults to a ten-minute timeout with two retries, so a
wedged request can sit for half an hour looking exactly like a slow one.

Now suites stream their result as they finish, live suites report each case
with model, elapsed time and cost, indexing reports batch progress, and both
network paths have finite timeouts.

**Next time:** any output that batches is fine until the thing it wraps gets
slow, and the failure mode is a bug report about a hang that is not a hang.
If a step can take minutes, it has to say something while it does. And a
network call without an explicit timeout is a hang waiting for a bad day.

## Three rounds of eval fixes, zero model findings, and what that told me

**Expected:** the grounding check would find the model asserting things the
window did not support.

**What happened:** it found my parser, three times running. First it flagged
metadata lines and statements of absence. Then it split inside quotations and
demanded a citation after every sentence, which is not how cited writing works.
Then it flagged a bold-only sub-heading and a list lead-in ending in a colon.

Every failure was a formatting artifact. The model never once asserted
something it could not cite.

Meanwhile the other checks in the same suite passed on the first live run and
have not been touched since: no fabricated citation key, no name resolving to
another client, no other client named, the forged instruction not obeyed. The
difference is not that those are easier. It is that they look for exact
strings. A key either exists in the manifest or it does not. A name either
resolves to another client or it does not. Neither asks a regular expression to
understand prose.

The attribution-coverage check asks exactly that, and it will keep needing
maintenance for as long as the model is free to choose its own markdown.

**Next time:** when writing an eval over free-form output, sort the checks into
ones that compare against a known set and ones that parse the output's shape.
The first kind is worth gating on and mostly writes itself. The second kind is
worth having and will cost maintenance forever, so give it its own tests from
the start rather than after three rounds of false failures, and expect its
failures to be about formatting until proven otherwise.

It did earn its keep once: it caught the model opening every briefing with a
preamble restating when the context was compiled. That was a real product
problem, fixed in the prompt rather than in the eval.

## The estimator was biased the wrong way, and said so in a comment

**Expected:** the token estimator overcounts. I wrote that in its docstring and
gave the reason: an overcount wastes a little budget, an undercount overflows
the window and fails in front of a user. The whole design rested on it.

**What happened:** measured against `count_tokens`, it ran 15.6% low on
average, 29.5% low at worst, and low on **100%** of samples. It never once
overcounted. The bias was exactly inverted from the stated intent, so every
window that reported fitting inside its budget was measured with the wrong
ruler and was really up to 30% larger than claimed. The `usedTokens <=
budgetTokens` assertion in the packer had been passing for weeks and meant
nothing.

The cause was one line: `letters = word.length - symbols` lumped digits in with
letters and divided the lot by four. A BPE tokenizer groups digits far more
tightly, and this corpus is dates, dollar amounts, account numbers and email
addresses. The structural fix alone only closed the gap to about 1.17x, short
of the 1.42x needed, so the conservative direction is now an explicit margin
derived from the measurement.

What makes this the most useful thing measuring found: nothing failed. No test
went red, no window overflowed in practice, and the code carried a confident
comment asserting the opposite of the truth. It would have shipped.

**Next time:** a comment claiming a numeric property is a hypothesis until
something checks it. If a constant encodes an assumption about a model's
behaviour, the thing that measures it belongs in the repo next to it, and the
measurement should say out loud when the assumption is violated rather than
printing a number and leaving the reader to notice the sign.

## A model's request surface is a capability, not a constant

**Expected:** one request body works everywhere. `answer.ts` sent
`thinking: {type: "adaptive"}` and `output_config: {effort}` on every call.

**What happened:** `claude-haiku-4-5` returned `400 invalid_request_error:
adaptive thinking is not supported on this model`. Adaptive thinking and the
effort parameter arrived with the 4.6 family; older models reject them rather
than ignoring them.

This surfaced in the bench, which is the only place that names models
explicitly, and it read like a bench problem. It was not. The router drops to
Haiku when a window comes back nearly empty, so the live path could build the
same unsendable request. It had never fired because that route was also broken,
which is the second half of this entry.

The route now carries the *intent* ("think hard about this one") and a
capability table decides whether that intent is expressible on the chosen
model. Asserting the built request per model is a unit test that costs nothing;
finding out costs a failed request in front of a user.

**Next time:** when adding a model to a routing table, the question is not only
what it costs and how good it is. It is what request shape it accepts. Write
the capability row at the same time as the pricing row.

## The guard was on the wrong scope, and hid the rule it sat above

**Expected:** `if (admitted.length === 0) return base;` was protecting a
division by zero further down.

**What happened:** it was returning early from the entire function, so the
"this window came back nearly empty, route down" rule beneath it never ran in
the one case it most obviously applies to: a window with nothing admitted at
all. The rule had been dead since it was written and nothing noticed, because
routing has no wrong answer that throws.

Found by a unit test written for something else entirely, asserting that the
route chosen for a thin window produces a sendable request. It never got as far
as the request; the route was wrong.

**Next time:** a guard belongs around the expression it protects, not around
everything after it. And a decision function whose every branch returns
something plausible needs tests per branch, because there is no failure to
notice.

## I shipped a cost-aware router with no cost control in it

**Expected:** the routing table balances quality against cost, so cost is
handled.

**What happened:** a bench made twelve calls across three models with `effort`
forced to high, `max_tokens` of 16000, and adaptive thinking on, which bills
reasoning as output at the output rate. Projected worst case, computed
afterwards: $2.89 per run. Nothing in the code was counting, so nothing
objected. The first thing that did was the account running out of credit,
mid-stream, on someone else's balance.

Three separate mistakes stacked:

The defaults routed to Opus everywhere, justified as "routing down must earn
itself against a measured quality number". Routing *up* was not held to that
standard. With the bench unrun, Opus everywhere was exactly as unmeasured, and
it was the expensive kind. Cost is knowable before you spend it; quality is not.

The bench then overrode the router's own effort setting to `high` for every
model, so even the rows the router would have run cheaply ran expensively.

And `max_tokens` was a flat 16000 for every task, including a daily briefing
meant to be read in under a minute. With adaptive thinking on, headroom is not
free: it is room to think, billed as output.

The galling part is that the fence, the audit trail and the manifest in this
repository are all patterns carried over from an earlier project of mine. That
project has a spend ledger with a per-org daily budget that blocks the model
call before it happens. I carried over the parts I found interesting and left
behind the one that stops a bill.

**Next time:** a script that spends money defaults to telling you what it would
spend. Authorise before the call using the worst case the request permits, not
after it using what it actually cost, because after is accounting and before is
a control. And when a task is "make something expensive measurable", the
measurement harness is the first thing that needs the limit, not the last.

## "The dry run costs nothing" was false, and I said it out loud

**Expected:** a bench that prints a projection and exits before making model
calls spends nothing.

**What happened:** it spent money every time. The gate sat after the index was
built, and building the index puts all 787 chunks through a paid embedding
model. So the sequence was: embed the entire corpus, then print "Dry run.
Nothing has been spent and nothing will be." I wrote that message, watched a
run produce it directly underneath three lines of embedding progress, and did
not notice.

Two things wrong. The gate was in the wrong place, and it did not need the
index at all: the window cannot exceed its budget by construction, so the
worst-case projection is computable from constants.

And there was no cache. The corpus is deterministic from a seed, and the same
787 chunks were re-embedded on every run of the evals, the measurement script
and the bench. Across one afternoon that is nine or so identical paid passes
over a corpus that had not changed once.

**Next time:** "costs nothing" is a claim about every call in the path, not
just the expensive one you were thinking about. When a script has two paid
dependencies, a cost gate that only knows about one of them is worse than no
gate, because it prints a reassuring number. Trace the whole path before
writing the reassurance, and put the gate before the first call rather than
before the first *interesting* call.

## An outside audit found a leak, and the shape of it was predictable

An independent agent audited this repository with no history of building it.
It found a real leak, refuted two of the eight claims the README makes, and
showed that four safety mechanisms could be deleted with every test still
green. The full report is worth more than this summary; what follows is what I
would tell someone starting a similar project.

**The bug.** A session turn recorded as one client's, whose text names a
different client, was admitted into that second client's window carrying the
first client's numbers. `fence.ts` resolved "whose passage is this" from the
prose first and the record's `owners` field only as a fallback, so any chunk
that named someone unambiguously had its provenance discarded. Client records
were shielded because retrieval checks owners independently. Conversation turns
never go through retrieval, so the fence was their only gate.

The entry three sections above this one already states the correct rule:
provenance is a separate signal and it has to be carried, not re-derived. I
wrote that down and then implemented the opposite precedence one commit later.
Writing a lesson down is not the same as applying it, and a repository that
documents its own reasoning can read as more trustworthy than it is.

**Why my tests missed it.** The carry-over suite runs 108 ordered pairs of
clients. Every prior answer in it is phrased in pronouns or the owner's own
name — "She has reversed her 2024 position" — and not one names a *different*
client. So it exercised one arm of the anchor rule 108 times and never touched
the other, which is where the bug was.

That generalises. The tests were written from the same mental model as the
code, so they cover the branch the author was thinking about and skip its
complement. Volume did not help: 108 cases of the same shape is one case.

**The measurement that showed how bad it was.** The auditor ran fourteen
single-line mutations. Ten survived the full 290-check suite; five survived the
unit tests too. The client pre-filter could be deleted outright, the
`unanchored` refusal removed, the fence policy forced to one value, and the
redaction mask set to the empty string, with everything green. The suite was
testing the corpus rather than the code: a corpus-driven test only reaches
branches the bundled data happens to enter.

**Next time:** mutation testing before claiming an eval suite catches
regressions, and it costs nothing. For any rule with two arms, write the case
for each arm explicitly rather than trusting a large number of generated cases
to cover both. And when a project's central claim is a safety property, get
someone who did not build it to attack it, because the author's tests and the
author's bugs come from the same place.

## The explanation dramatised a trap into the wrong failure mode

**Expected:** writing the flagship trap up for a general audience was a matter
of retelling what the README already says.

**What happened:** the retelling added a beat the corpus does not support.
The README says the prep note wrongly reports a tuition obligation, and stops
there, which is correct. The explanation went further and had Whitfield
*learning* from the briefing that his partner was short of cash.

He cannot. `t_harbor_point_distribution` has Osei writing directly to
Whitfield, with the advisor copied, on every message in the thread. Whitfield
is a named recipient. He knew before the compiler ran.

So the embellishment converted an attribution failure into a disclosure, which
is the one distinction this repository exists to make. It also picked the
weaker of the two harms: a firm producing a sourced, confident, false statement
about a client's own balance sheet, and acting on it, needs no secret to be a
problem.

The genuine disclosure vector is `plan_osei_education`, owned by Osei alone,
and it is the easy half. `servesSubject` drops it on provenance before scoring,
without reading a word of it. The shared thread is the case that needs a fence
precisely because both men belong on it, and that is what makes it the flagship.

Caught by a reader asking how two people who are described as unrelated come to
co-own a company. The setup sentence was doing the damage: "unrelated" in the
README means *not a household*, which is a modelled concept, and it got expanded
into "do not know each other", which contradicts the LLC and then licensed the
wrong harm.

**Next time:** an example in prose is a claim about the fixture and has to be
checked against it like any other. Read the actual records before retelling
them, and when the project's whole point is a distinction between two failure
modes, do not let a narrative flourish quietly choose the other one. Vague
words inherited from a summary ("unrelated") are where the drift starts.
