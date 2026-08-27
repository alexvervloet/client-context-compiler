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
