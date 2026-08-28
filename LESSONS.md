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
