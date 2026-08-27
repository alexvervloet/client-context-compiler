/**
 * Assembles a firm: the roster, the traps, and enough ordinary traffic around
 * them that retrieval has to work for a living.
 *
 * The filler is deliberately mundane. If the only client-layer text in the
 * corpus were the traps, a fence that dropped everything would score
 * perfectly, and so would a retriever that returned nothing.
 */

import type { CalendarEvent, Corpus, GmailThread, MeetingNote, PlanningDocument } from "./shapes.ts";
import { contactFrom, eventFrom, noteFrom, planFrom, threadFrom } from "./build.ts";
import type { MessageSpec } from "./build.ts";
import { ADVISORS, CLIENTS, FIRM_NAME, advisorById } from "./roster.ts";
import type { ClientSeed } from "./roster.ts";
import { FIRM_DOCS } from "./firm-docs.ts";
import { TRAP_EVENTS, TRAP_NOTES, TRAP_PLANS, TRAP_THREADS } from "./traps.ts";
import { makeRng } from "./rng.ts";
import type { Rng } from "./rng.ts";

const CORPUS_START = Date.parse("2024-01-08T00:00:00Z");
const CORPUS_END = Date.parse("2026-08-26T00:00:00Z");

/** Subject lines an advisor's inbox actually fills up with. */
const CLIENT_TOPICS = [
  "Quarterly statement is up",
  "Rebalance confirmation",
  "Cash flow for next quarter",
  "Beneficiary form",
  "Address change",
  "Tax documents",
  "Wire confirmation",
  "Question about a fee line",
  "Moving the standing transfer",
  "Estimated tax payment",
  "Reviewing the IPS",
  "Statement question",
  "Charitable gift timing",
  "RMD for this year",
  "Insurance review",
] as const;

const ADVISOR_LINES = [
  "Posted this morning. Nothing moved outside the bands, so I did not trade.",
  "Confirming we executed at the open. The tax lot report is attached.",
  "I can free that up without selling anything. Give me until Thursday.",
  "Signed copy is on file. Nothing else needed from you.",
  "Updated in our system and with the custodian. Both confirmed.",
  "The 1099 lands in mid-February. I will send it the day it posts.",
  "Wire is out, reference on the confirmation. Call if it has not landed by five.",
  "That line is the custodian's, not ours. I have asked them to waive it.",
  "Changed. First run under the new amount is the first of next month.",
  "Estimate is a touch lower than last quarter. Voucher attached.",
] as const;

const CLIENT_LINES = [
  "Thanks, that answers it.",
  "Can we talk through this rather than email?",
  "Understood. Let us leave it where it is for now.",
  "One more thing while I have you.",
  "That is lower than I expected. Is that right?",
  "Go ahead.",
  "I would rather wait until after the closing.",
  "Please hold off until I have spoken to my accountant.",
] as const;

function isoBetween(rng: Rng, startMs: number, endMs: number): string {
  return new Date(startMs + Math.floor(rng.next() * (endMs - startMs))).toISOString();
}

function bulkThreadsFor(client: ClientSeed, rng: Rng, index: number): GmailThread[] {
  const advisor = advisorById(client.advisorId);
  const count = rng.int(22, 32);
  const threads: GmailThread[] = [];

  for (let i = 0; i < count; i++) {
    const opened = isoBetween(rng, CORPUS_START, CORPUS_END);
    const topic = rng.pick(CLIENT_TOPICS);
    const interest = rng.pick(client.interests);
    const clientOpens = rng.chance(0.45);

    const specs: MessageSpec[] = [];
    if (clientOpens) {
      specs.push({
        from: client.email,
        to: [advisor.email],
        subject: `${topic}`,
        date: opened,
        body: `${rng.pick(CLIENT_LINES)} This is about ${interest}.`,
      });
      specs.push({
        from: advisor.email,
        to: [client.email],
        subject: topic,
        date: new Date(Date.parse(opened) + rng.int(1, 40) * 3_600_000).toISOString(),
        body: rng.pick(ADVISOR_LINES),
      });
    } else {
      specs.push({
        from: advisor.email,
        to: [client.email],
        subject: topic,
        date: opened,
        body: `${rng.pick(ADVISOR_LINES)} Relevant to ${interest}.`,
      });
      if (rng.chance(0.6)) {
        specs.push({
          from: client.email,
          to: [advisor.email],
          subject: topic,
          date: new Date(Date.parse(opened) + rng.int(1, 60) * 3_600_000).toISOString(),
          body: rng.pick(CLIENT_LINES),
        });
      }
    }

    threads.push(threadFrom(`t_${index}_${i}_${client.id.slice(3)}`, specs));
  }

  return threads;
}

function bulkEventsFor(client: ClientSeed, rng: Rng, index: number): CalendarEvent[] {
  const advisor = advisorById(client.advisorId);
  const count = rng.int(4, 8);
  const events: CalendarEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push(
      eventFrom({
        id: `ev_${index}_${i}_${client.id.slice(3)}`,
        summary: `${client.first} ${client.last} — ${rng.pick(["review", "check-in", "planning session", "call"])}`,
        start: isoBetween(rng, CORPUS_START, CORPUS_END),
        durationMinutes: rng.pick([30, 45, 60]),
        organizerEmail: advisor.email,
        attendeeEmails: [client.email],
        status: rng.chance(0.08) ? "cancelled" : "confirmed",
      }),
    );
  }
  return events;
}

function bulkNotesFor(client: ClientSeed, rng: Rng, index: number): MeetingNote[] {
  const advisor = advisorById(client.advisorId);
  const count = rng.int(2, 5);
  const notes: MeetingNote[] = [];
  for (let i = 0; i < count; i++) {
    const date = isoBetween(rng, CORPUS_START, CORPUS_END).slice(0, 10);
    notes.push(
      noteFrom(
        `note_${index}_${i}_${client.id.slice(3)}`,
        advisor.email,
        [client.email],
        date,
        `${client.last} — meeting notes`,
        [
          `Covered ${rng.pick(client.interests)}.`,
          `Risk rating on file at the time: ${client.risk}.`,
          rng.pick([
            "No changes agreed. Next review in six months.",
            "Agreed to revisit after the next statement.",
            "Client asked for a written summary. Sent same day.",
            "Open item carried forward from last time.",
          ]),
        ].join("\n"),
      ),
    );
  }
  return notes;
}

function bulkPlansFor(client: ClientSeed, rng: Rng, index: number): PlanningDocument[] {
  const kinds: Array<PlanningDocument["kind"]> = ["retirement", "tax"];
  return kinds.map((kind, i) =>
    planFrom(
      `plan_${index}_${i}_${client.id.slice(3)}`,
      [client.email],
      `${client.first} ${client.last} — ${kind} plan`,
      kind,
      isoBetween(rng, Date.parse("2025-06-01T00:00:00Z"), CORPUS_END).slice(0, 10),
      [
        `Portfolio of record: $${client.portfolioUsd.toLocaleString("en-US")}.`,
        `Risk rating: ${client.risk}, reviewed ${client.riskReviewed}.`,
        kind === "retirement"
          ? `Target draw begins at ${rng.int(62, 70)}. Modelled success rate ${rng.int(78, 96)}%.`
          : `Realised gains year to date: $${(rng.int(4, 90) * 1000).toLocaleString("en-US")}.`,
      ].join("\n"),
    ),
  );
}

export function generateCorpus(seed = 20260827): Corpus {
  const rng = makeRng(seed);

  const threads: GmailThread[] = [...TRAP_THREADS];
  const events: CalendarEvent[] = [...TRAP_EVENTS];
  const notes: MeetingNote[] = [...TRAP_NOTES];
  const plans: PlanningDocument[] = [...TRAP_PLANS];

  CLIENTS.forEach((client, index) => {
    threads.push(...bulkThreadsFor(client, rng, index));
    events.push(...bulkEventsFor(client, rng, index));
    notes.push(...bulkNotesFor(client, rng, index));
    plans.push(...bulkPlansFor(client, rng, index));
  });

  const contacts = CLIENTS.map((client) => {
    const lastContacted = threads
      .filter((t) => t.messages.some((m) => m.payload.body.data.includes(client.first)))
      .map((t) => t.messages[t.messages.length - 1]?.internalDate ?? "0")
      .sort()
      .at(-1);
    return contactFrom(client, new Date(Number(lastContacted ?? CORPUS_END)).toISOString());
  });

  return {
    seed,
    firmName: FIRM_NAME,
    contacts,
    threads,
    events,
    notes,
    plans,
    firmDocs: FIRM_DOCS,
  };
}

/** Advisors, for anything that needs the authorization list. */
export function advisorRoster(): typeof ADVISORS {
  return ADVISORS;
}
