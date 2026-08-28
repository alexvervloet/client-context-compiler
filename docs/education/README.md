# Five levels

The same system, explained five times, to five readers. Each document goes as
deep as its reader's ceiling allows and then stops, rather than stopping where
the topic gets awkward.

They are not summaries of each other. A concept that appears at more than one
level is doing different work each time. The token estimator bug is a story
about comments lying at level 1, a measurement methodology at level 3, and a
scope error in how a safety margin was derived at level 5.

| level | reader | what it assumes |
| --- | --- | --- |
| [1](1-high-school.md) | a teenager in Intro to CS | variables, loops, lists, functions, strings |
| [2](2-undergraduate.md) | a second-year CS student | data structures, regex, complexity, testing, dot products |
| [3](3-ai-newcomer.md) | a CS graduate learning AI | strong CS, has called an LLM API, new to shipping one |
| [4](4-engineering-manager.md) | an EM interviewing for an AI role | runs teams, reads diagrams, no hands-on AI |
| [5](5-senior-ai-engineer.md) | a senior AI engineer | has shipped retrieval systems, wants the design review |

## What the system is, in one paragraph

A financial advisor's AI assistant can only use what you paste into its context
window, and everything does not fit. This project decides what goes in: it packs
firm knowledge, one client's history, and the current conversation under a token
budget, and it refuses to admit any text that names a different client. That
refusal is the point. The advisor is *authorized* to read both clients' files,
so no permission check catches the case where a document legitimately mentions
both and the briefing reports one man's obligation as the other's.

## Where to start

If you have built RAG before and want the argument rather than the tutorial, go
straight to [level 5](5-senior-ai-engineer.md) and read
[LESSONS.md](../LESSONS.md) alongside it.

If you are preparing for an interview and need to be able to interrogate
someone else's system, [level 4](4-engineering-manager.md) is written for
exactly that, and the questions in it work regardless of your own depth.

If you want to understand why any of this is hard, start at
[level 1](1-high-school.md). It is short and it contains the whole problem.

## The thread that runs through all five

Every level lands on some version of the same four ideas, at the resolution that
reader can use.

**Being allowed to see a document is not the same as the document being about
you.** Authorization is a solved problem with mature tooling. Attribution is not,
and it fails while every control reports success.

**Rules that matter go in code, not in prompts.** A prompt is a request that
competes for attention with every sentence in every retrieved document. A
function that refuses to return the text is not.

**Record the decision when you make it.** The manifest, the session turn's
subject, the record's owner fields. All three are the same move: capture what
you know at the moment you know it, because reconstructing it later from the
words is guesswork, and guesswork is invisible once it happens.

**Measure the things you assert.** A comment claiming the token estimator
overcounted was wrong by 30% for weeks, in the dangerous direction, with nothing
red and nobody complaining. Then an outside audit ran fourteen mutations against
a 290-check suite and ten of them survived. Both numbers came from someone
choosing to check rather than from anything failing.
