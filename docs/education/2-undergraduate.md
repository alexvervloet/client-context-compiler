# Level 2: the second-year CS student

You have done data structures, some algorithms, regular expressions, and a
testing course that you may or may not have taken seriously. You know what a
hash map costs and what a dot product is. You have probably not studied machine
learning yet.

Good. Almost nothing here needs machine learning. The interesting parts of this
project are string scanning, set logic, a greedy packing loop, and an invariant
check. The AI is at the end and it is the least interesting component.

## The problem, stated precisely

Input:

- A corpus of `n` text records with metadata (787 in the bundled test firm).
- A subject client `s`.
- An advisor `a` with a set of clients they may access.
- A token budget `B`.
- A task kind, one of four.

Output:

- A string of at most `B` tokens.
- A manifest: for every candidate record, whether it made it in, and why not.

Constraints:

1. The output string contains no reference to any client other than `s`.
2. The output string costs at most `B` tokens.
3. Both constraints are enforced, not requested. A violation raises.

That is a filtering and packing problem with a hard invariant on the output.
The fact that the output eventually gets handed to a language model changes
essentially nothing about the algorithm.

## The pipeline

```
source records
    |
    v
normalize        split into chunks, attach provenance and mentions
    |
    v
index            one vector per chunk (built once, reused)
    |
    v
search           filter by subject, score, rank, truncate     [per request]
    |
    v
fence            per-chunk admit / redact / refuse            [per request]
    |
    v
pack             greedy fill under per-layer budgets          [per request]
    |
    v
assert           re-scan the assembled string                 [per request]
```

The split matters for cost. Normalize and index are `O(n)` and expensive, and
they do not depend on who is asking, so they run once at startup. Everything
after that is per request.

## Part one: finding names in text

The core primitive is: given a string, which clients does it mention, and where?

Naive approach: build a map from every surface form to a client id, then scan.

```ts
"margaret chen"  -> [cl_chen_margaret]
"margaret"       -> [cl_chen_margaret]
"chen"           -> [cl_chen_margaret, cl_chen_david]
"david chen"     -> [cl_chen_david]
"m.chen@example.com" -> [cl_chen_margaret]
```

Two things fall out of that table immediately.

### A form maps to a set, not to a client

`"chen"` is two people. `"james"` is two people. The type has to be
`Map<string, ClientId[]>`, and the code has to keep it a set the whole way
through rather than picking a favourite.

The design decision here, and I think it is the right one: **ambiguity resolves
outward.** A bare "Chen" marks the passage as being about *both* Chens, which
makes it cross-client and forces the fence to make a decision about it.

The alternative is to guess. Guessing is how a briefing asserts one spouse's
holdings as the other's, and the moment a guess is made it becomes invisible.
Nothing downstream can tell a resolved reference from a guessed one. Widening is
recoverable, guessing is not.

### Longest match wins, and it has to consume characters

"Margaret Chen" contains "Chen". If you scan for both forms independently you
get two mentions on the same text, one unambiguous and one not.

Standard fix, and if you have written a lexer you have seen it: sort patterns
longest first, and track claimed spans.

```ts
const forms = [...collected.entries()]
  .map(([form, ids]) => ({ form, pattern: /* ... */, clients: [...ids].sort() }))
  .sort((a, b) => b.form.length - a.form.length);   // maximal munch
```

```ts
const claimed: Array<[number, number]> = [];
const overlaps = (start: number, end: number): boolean =>
  claimed.some(([s, e]) => start < e && end > s);
```

Longer form runs first, claims its characters, and the shorter pattern's match
is discarded because it overlaps. Same idea as maximal munch in a tokenizer.

`overlaps` is `O(k)` in the number of claimed spans, making the scan
`O(forms x matches x k)`. For a twelve-client roster nobody cares. At ten
thousand clients you would replace the form list with an Aho-Corasick automaton
and the span list with an interval tree. The interface would not change.

### The bug that would have destroyed the whole thing

Here is a real one, from [LESSONS.md](../LESSONS.md), and it is the kind of bug
that ships.

The pattern was `\bokonkwo\b`. Word boundary on both sides. Reasonable.

Then it matched inside `ngozi.okonkwo@example.test`.

Work out why before reading on.

`\b` sits between a word character and a non-word character. `.` is not a word
character. Neither is `@`. So in `ngozi.okonkwo@example.test`, the position
before the `o` in `okonkwo` is a perfectly valid word boundary, and so is the
position after the final `o`. The regex is doing exactly what it was asked.

The consequence is nasty. Every email addressed to one Okonkwo sibling gets
labelled as being about all three, because the surname appears inside the
address. The fence then sees contamination everywhere and drops good material,
and the manifest gives a reason that looks entirely principled: "cross-client".

**Nothing throws.** No test fails. The system quietly gets worse.

The fix is precedence: resolve email addresses first, let them claim their
character spans, and the name patterns can no longer see inside them.

```ts
// Email addresses first, and they keep their characters. An address
// contains a surname, so letting a name rule match inside one turns
// ngozi.okonkwo@example.test into a mention of all three Okonkwos.
for (const [email, client] of index.byEmail) { /* claim spans */ }
for (const { pattern, clients } of index.forms) { /* skip overlaps */ }
```

The testing lesson is the more useful half. The test that caught this asserted
the **exact set** of clients found. A test written as

```ts
assert(found.includes("cl_okonkwo_ngozi"));    // passes. bug still there.
```

would have passed forever. For any extraction function, assert the whole set.
Extra results are as much a bug as missing ones, and `includes` cannot see them.

## Part two: the two sources of truth

Every chunk carries two separate answers to "who is this about", and keeping
them separate is the single most important structural decision in the codebase.

```ts
export type Chunk = {
  // ...
  /** Every client this chunk could concern. The coarse view, used for filtering. */
  clients: ClientId[];
  /** Who the source record belongs to, from its own fields rather than its prose. */
  owners: ClientId[];
  mentions: Mention[];
};
```

`mentions` comes from scanning the prose. `owners` comes from the record's
structural fields: the `From` and `To` headers on an email, the attendee list on
a calendar event, the client id on a CRM row.

They disagree constantly, in both directions:

- A trust document is addressed to two siblings and discusses a third. Prose
  catches the third, structure does not.
- A meeting note is titled `Okonkwo, meeting notes`, which names three people
  and nobody in particular. Prose is useless here. The attendee list names
  exactly one person.

Neither field can be derived from the other, so both get carried. And when they
conflict, **provenance wins**. A note in Elena's file that says "For Margaret
Chen: the deposit must clear before closing" is still Elena's note and still
carries Elena's numbers, no matter that the only name in it is Margaret's.

That precedence is a one-line ordering constraint in `fence.ts`:

```ts
// Provenance is authoritative, and this check has to come before any
// reasoning about the prose.
const foreignOwners = chunk.owners.filter((c) => c !== subject);
if (chunk.owners.length > 0 && !chunk.owners.includes(subject)) {
  return { action: "refuse", reason: "other-client-only", offending: foreignOwners.sort() };
}
```

That check used to run *after* the prose reasoning. An outside auditor found the
leak that caused. Ordering in a decision function is not stylistic.

## Part three: the fence as a total function

```ts
export type FenceVerdict =
  | { action: "admit";  text: string; ambiguous: Mention[] }
  | { action: "redact"; text: string; masked: ClientId[]; ambiguous: Mention[] }
  | { action: "refuse"; reason: RefuseReason; offending: ClientId[] };
```

This is a discriminated union, or a tagged union, or a sum type, depending on
which language you learned it in. TypeScript narrows on `action`, so once you
check `verdict.action === "refuse"` the compiler knows `verdict.reason` exists
and `verdict.text` does not.

Two properties worth naming:

**Every refusal carries a reason and the offending client ids.** Not a boolean.
A `false` is unactionable during an incident review; `{ reason:
"shared-record", offending: ["cl_osei_james"] }` tells you exactly what
happened.

**The function is pure.** Chunk in, verdict out, no I/O, no mutation, no clock.
It is trivially testable, which is why it has the most tests in the repository.

### The interesting case is the middle one

Sorting mentions by their relationship to the subject `s`:

```ts
function classify(mentions, subject) {
  const contaminating = [], ambiguous = [];
  for (const mention of mentions) {
    if (mention.candidates.includes(subject)) {
      if (mention.candidates.length > 1) ambiguous.push(mention);
      continue;
    }
    contaminating.push(mention);
  }
  return { contaminating, ambiguous };
}
```

Three cases:

| candidates | meaning |
| --- | --- |
| `{s}` | a clean reference to the subject |
| excludes `s` | contamination, however many candidates |
| includes `s`, size > 1 | ambiguous, and this is the hard one |

"Okonkwo" inside Adaeze's window probably means Adaeze. If you refuse every
ambiguous form you throw away most of a family's records for nothing.

But "Okonkwo" alone in a note that names nobody else means any of three
siblings, and admitting it files one sibling's notes under another.

The rule that resolves it: **an ambiguous name is harmless only when something
else already pins the passage to the subject.** An unambiguous name elsewhere in
the text is the best anchor. The record's `owners` are the fallback. Nothing
anchoring it means refuse.

```ts
const anchors = resolved.size > 0 ? resolved : new Set(chunk.owners);
const anchoredToSubject = anchors.has(subject);

if (ambiguous.length > 0 && !anchoredToSubject) {
  return { action: "refuse", reason: "unanchored", /* ... */ };
}
```

### Verifying the mask instead of trusting it

Under the `redact` policy, the fence blanks foreign names and keeps the passage.
Two details in that implementation are worth stealing.

```ts
// Mask right to left so earlier offsets stay valid.
for (const mention of [...contaminating].sort((a, b) => b.start - a.start)) {
  text = text.slice(0, mention.start) + MASK + text.slice(mention.end);
}
```

Replacing left to right invalidates every subsequent offset, because `MASK` is a
different length from the name it replaces. Right to left, every edit is beyond
the offsets you have not used yet. This comes up any time you patch a string by
index, and getting it wrong produces corruption that looks random.

```ts
// Prove it. Re-running detection over the masked text is cheap.
const survivors = classify(findMentions(text, index), subject).contaminating;
if (survivors.length > 0) {
  return { action: "refuse", reason: "redaction-incomplete", /* ... */ };
}
```

Do not trust the transformation. Re-run detection over the output. A redaction
that silently failed is worse than no redaction, because the caller believes it
worked. This costs one extra scan of a short string.

## Part four: retrieval, without the ML

You have `n` chunks and a query. You want the most relevant `k`.

The trick everyone uses: convert each chunk to a fixed-length vector of floats,
convert the query the same way, and rank by how aligned the vectors are.

For the mock embedder here, that conversion is hashing, and you already know how
to read it:

```ts
const vector = new Float32Array(256);
for (const token of tokenize(text)) {
  const h = hash(token);                          // FNV-1a
  vector[h % 256]        += 1;
  vector[(h >>> 8) % 256] -= 0.5;                 // two slots, signed
}
normalize(vector);                                // scale to unit length
```

That is a bag of words hashed into 256 buckets. Two slots with opposite signs
per token so unrelated tokens tend to cancel rather than accumulate in the same
direction. Collisions happen and that is accepted.

Similarity is the dot product:

```ts
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}
```

From your linear algebra course: `a . b = |a| |b| cos(theta)`. Both vectors are
normalized to unit length, so `|a| = |b| = 1`, and the dot product *is* the
cosine of the angle. Hence the name, and hence the range `[-1, 1]` with 1
meaning identical direction.

The real embedder replaces the hash with a neural network that maps meaning
rather than spelling, so "she wants less risk" and "conservative allocation"
land near each other. Everything downstream is unchanged. That is the whole
extent of the machine learning in this pipeline, and the code treats it as a
swappable interface:

```ts
export type Embedder = {
  readonly name: string;
  readonly dimensions: number;
  readonly isMock: boolean;
  embed(texts: string[]): Promise<Float32Array[]>;
};
```

### Two design decisions in the search loop

**The client filter runs before scoring, not after.**

```ts
for (let i = 0; i < index.chunks.length; i++) {
  // The filter, before the comparison.
  if (!servesSubject(chunk, options.subject)) continue;
  const similarity = cosine(queryVector, vector);
  // ...
}
```

The common shape is to rank everything and filter the top-k afterwards. That is
wrong twice. It leaks through top-k: ask for 20, discard 11 that belong to other
clients, build the window from 9. And it means a forbidden chunk was scored,
logged and traced before anyone asked whether it was allowed to exist in that
request.

Same asymptotic cost either way. Different correctness.

**The relevance floor is relative and conditional.**

An earlier version had `if (similarity < 0.02) skip`. Two bugs in one line.

The number is absolute, so it encodes the score distribution of one specific
embedding model. The mock and the real embedder do not share a range, and a
threshold tuned against one silently empties windows under the other.

And it applied unconditionally, including to a client whose entire file is four
records. There is no long tail to trim there, and trimming anyway returns an
empty window.

```ts
const applyFloor = scored.length > topK && best > 0;
const floor = best * relativeFloor;   // relativeFloor = 0.15
```

Relative to the best match *in this search*, and only when there is actually a
tail. The general rule: **a tuned constant that touches model output should be
relative to something observed in the same call, not absolute.**

## Part five: packing under a budget

This is a knapsack problem with a twist. Classic 0/1 knapsack is NP-hard and
solved with dynamic programming in `O(nB)`.

This code does not do that. It sorts by score and takes greedily:

```ts
for (const layer of FILL_ORDER) {          // firm, conversation, client
  const share = Math.floor(available * budgets[layer]);
  const allowance = layer === "client" ? remaining : Math.min(share, remaining);
  let spent = 0;

  for (const candidate of byLayer[layer]) {
    const verdict = fence(chunk, { subject, authorized, index, policy });
    if (verdict.action === "refuse") { record(); continue; }

    const cost = estimateTokens(renderRecord(record));
    if (spent + cost > allowance) { record("over-budget"); continue; }

    spent += cost;
    admitted[layer].push(record);
  }
  remaining -= spent;
}
```

Greedy is the right call and it is worth being able to defend that in an
interview. Three reasons.

The value function is not real. The "score" is a heuristic blend of cosine
similarity and recency. Optimising exactly against an approximate objective buys
you nothing but runtime.

The order is meaningful on its own. A window sorted by relevance puts the
important material where models attend to it best. A DP-optimal knapsack
solution would reorder for fit, which is actively worse.

And explainability. Greedy gives a manifest anyone can read: "this scored
higher, so it went first, and by the time we reached yours there were 40 tokens
left." Explaining a DP table to a compliance officer is not a thing you want to
do.

### Layer quotas

```ts
export const LAYER_BUDGETS: Record<TaskKind, Record<MemoryLayer, number>> = {
  "daily-briefing":        { firm: 0.10, conversation: 0.10, client: 0.80 },
  "meeting-prep":          { firm: 0.15, conversation: 0.10, client: 0.75 },
  "post-meeting-followup": { firm: 0.10, conversation: 0.25, client: 0.65 },
  "compliance-review":     { firm: 0.35, conversation: 0.05, client: 0.60 },
};
```

Without quotas, a single global ranking lets the client layer win everything,
because a client's own email is always a better lexical match for a query about
that client than a firm policy document is.

For a compliance review that is a task failure. The reviewer's job is to check
the file against the firm's documentation standard, and a window with no
documentation standard in it cannot do that, however relevant every admitted
chunk was.

Unspent share rolls forward and the client layer is filled last, so it inherits
all the slack.

### Cost what you render

```ts
// Cost what will actually be rendered, citation line and blank lines
// included. Costing the bare chunk and rendering something larger is how
// a window overflows a budget it was told to respect.
const cost = estimateTokens(renderRecord(record));
```

An earlier version costed `chunk.text` and then rendered

```
\n\n[gmail:message/m1] (ambiguous reference: "Chen")\n<the text>
```

The delta is small per chunk and it overflowed the budget by 5% across a window.
**Measure the string you are about to emit, not the string you started from.**

The header and layer headings get their own reservation up front, and a budget
below that cost throws with an honest message rather than producing a nonsense
window.

## Part six: testing, and why 108 cases were one case

The repository has 290 deterministic checks. Here is where they were weak,
because the failure is more instructive than the pass.

The carry-over suite runs every ordered pair of one advisor's clients: 9 clients
gives 72 pairs, times tasks, 108 cases. That sounds thorough.

An outside auditor found a leak it missed completely.

Look at the fixture data:

```ts
const PRIOR_ANSWER: Record<string, string> = {
  cl_chen_margaret:
    "She has reversed her 2024 position and the muni ladder should not be touched...",
  cl_chen_david:
    "The concentrated position in his consulting LLC escrow is still 31%...",
  // ...
};
```

Every single prior answer is phrased in pronouns or the owner's own name. Not
one of them names a *different* client.

The anchor rule has two arms: prose names somebody, or prose names nobody and we
fall back to owners. All 108 cases exercise the second arm. The bug lived in the
first arm, which zero cases touched.

**108 cases of the same shape is one case.** Volume is not coverage. The tests
were written from the same mental model as the code, so they cover the branch
the author was thinking about and skip its complement.

Concretely: for any rule with two arms, write a case for each arm by hand. Do
not trust generated volume to cover both.

### Mutation testing, which costs nothing and would have caught it

The auditor also ran mutation testing. The idea is embarrassingly simple: break
the code on purpose, one small change at a time, and see whether the tests
notice. A mutation the tests do not catch marks a line nothing is verifying.

Fourteen single-line mutations. **Ten survived the full 290-check suite. Five
survived the unit tests too.**

Things that could be deleted with everything still green:

- The client pre-filter in retrieval, removed entirely.
- The `unanchored` refusal branch.
- The fence policy, forced to a single value.
- The redaction mask, set to the empty string.

The diagnosis: the suite was testing the *corpus* rather than the *code*. A
corpus-driven test only reaches the branches the bundled data happens to enter,
and no amount of iterating over that corpus changes which branches those are.

If you take one practical thing from this document, take this. Before you claim
a test suite catches regressions, mutate the code and check. It is a few hours
of work and it tells you what your coverage percentage cannot.

## Complexity summary

| stage | cost | when |
| --- | --- | --- |
| normalize | `O(n x L)`, `L` chunk length | startup |
| build index | `O(n)` embed calls, batched at 96 | startup |
| find mentions | `O(F x M x C)`, forms x matches x claimed | per chunk |
| search | `O(n x d)`, `d = 256` or 1024 | per request |
| sort | `O(n log n)` | per request |
| fence | `O(k x L)` over survivors | per request |
| pack | `O(k)` | per request |
| final assert | `O(B)` over the window | per request |

The linear scan in search is fine at `n = 787` and wrong at `n = 10^7`, where
you would reach for approximate nearest neighbours (HNSW, IVF). Note that
`servesSubject` filtering before scoring means the effective `n` is per client,
not per firm, which buys a lot of headroom before that becomes urgent.

## What to take away

**Ambiguity widens, it does not guess.** A set-valued result you can reason
about beats a scalar that silently picked one.

**Carry provenance, do not re-derive it.** Structural metadata answers questions
prose cannot, and the moment you throw it away it is gone.

**Enforce invariants at the boundary, not by convention.** The final
`assertSingleClient` scan over the finished window is the difference between a
property you believe and a property that holds.

**Verify transformations rather than trusting them.** Re-run mention detection
after masking. It costs microseconds.

**Assert exact sets in extraction tests.** `includes` is blind to the bug that
adds results.

**Mutate your code to test your tests.** Ten out of fourteen mutations survived
a 290-check suite here.

---

Previous: [the teenager](1-high-school.md). Next:
[a CS graduate learning AI](3-ai-newcomer.md), where the machine learning stops
being a swappable interface and starts having opinions.
