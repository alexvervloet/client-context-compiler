/**
 * Source records become chunks.
 *
 * One invariant runs through this file: a chunk's `mentions` are computed over
 * exactly the string that will be rendered into the context window. Not the
 * body without the subject line, not the paragraph without its title. Any gap
 * between what gets analysed and what gets shown is a hole the fence cannot
 * see through, and holes of that shape are the whole reason this project
 * exists.
 *
 * Chunk granularity is a contamination control, not only a retrieval knob.
 * The Okonkwo trust document names three clients; split into paragraphs, the
 * paragraph about one sibling's sub-account names only that sibling and can be
 * admitted on its own. Kept whole, the entire document is unusable for anyone.
 */

import type { Chunk, MemoryLayer, SourceRef } from "./types.ts";
import type { Corpus } from "./corpus/shapes.ts";
import { addresses, header } from "./corpus/shapes.ts";
import { findMentions, mentionedClients } from "./mentions.ts";
import type { MentionIndex } from "./mentions.ts";
import { buildMentionIndex } from "./mentions.ts";
import { estimateTokens } from "./tokens.ts";

/** Paragraphs longer than this get their own chunk; shorter ones merge. */
const MIN_PARAGRAPH_CHARS = 120;

function splitParagraphs(body: string): string[] {
  const raw = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (raw.length <= 1) return raw;

  // Merge runt paragraphs forward so a one-line heading does not become a
  // chunk of its own with no context and no mentions.
  const merged: string[] = [];
  for (const paragraph of raw) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && previous.length < MIN_PARAGRAPH_CHARS) {
      merged[merged.length - 1] = `${previous}\n${paragraph}`;
    } else {
      merged.push(paragraph);
    }
  }
  return merged;
}

function makeChunk(
  id: string,
  layer: MemoryLayer,
  text: string,
  ref: SourceRef,
  timestamp: string,
  index: MentionIndex,
): Chunk {
  const mentions = findMentions(text, index);
  return {
    id,
    layer,
    text,
    ref,
    timestamp,
    clients: mentionedClients(mentions),
    mentions,
    tokens: estimateTokens(text),
  };
}

export function normalize(corpus: Corpus, index: MentionIndex = buildMentionIndex()): Chunk[] {
  const chunks: Chunk[] = [];

  for (const contact of corpus.contacts) {
    const p = contact.properties;
    const text = [
      `CRM record — ${p.firstname} ${p.lastname} <${p.email}>`,
      `Household: ${p.household_id}. Advisor: ${p.advisor_owner}.`,
      `Portfolio of record: $${Number(p.portfolio_value_usd).toLocaleString("en-US")}.`,
      `Risk tolerance on file: ${p.risk_tolerance} (reviewed ${p.risk_tolerance_reviewed}).`,
      `KYC review due: ${p.kyc_review_due}.`,
    ].join("\n");
    chunks.push(
      makeChunk(
        `ch_crm_${contact.id}`,
        "client",
        text,
        {
          system: "crm",
          kind: "contact",
          id: contact.id,
          label: `CRM contact — ${p.firstname} ${p.lastname}`,
          timestamp: contact.updatedAt,
        },
        contact.updatedAt,
        index,
      ),
    );
  }

  for (const thread of corpus.threads) {
    for (const message of thread.messages) {
      const subject = header(message, "Subject");
      const from = header(message, "From");
      const to = addresses(header(message, "To"));
      const cc = addresses(header(message, "Cc"));
      const sent = new Date(Number(message.internalDate)).toISOString();

      const lines = [`Email — ${subject}`, `From: ${from}`, `To: ${to.join(", ")}`];
      if (cc.length > 0) lines.push(`Cc: ${cc.join(", ")}`);
      lines.push(`Date: ${sent.slice(0, 10)}`, "", message.payload.body.data);

      chunks.push(
        makeChunk(
          `ch_msg_${message.id}`,
          "client",
          lines.join("\n"),
          {
            system: "gmail",
            kind: "message",
            id: message.id,
            label: `Email: ${subject} (${sent.slice(0, 10)})`,
            timestamp: sent,
            url: `https://mail.google.com/mail/u/0/#inbox/${thread.id}`,
          },
          sent,
          index,
        ),
      );
    }
  }

  for (const event of corpus.events) {
    const when = event.start.dateTime;
    const lines = [
      `Calendar — ${event.summary}`,
      `When: ${when.slice(0, 16).replace("T", " ")} (${event.start.timeZone})`,
      `Attendees: ${event.attendees.map((a) => a.email).join(", ")}`,
      `Status: ${event.status}`,
    ];
    if (event.location !== undefined) lines.push(`Location: ${event.location}`);
    if (event.description !== undefined) lines.push("", event.description);

    chunks.push(
      makeChunk(
        `ch_ev_${event.id}`,
        "client",
        lines.join("\n"),
        {
          system: "gcal",
          kind: "event",
          id: event.id,
          label: `Calendar: ${event.summary} (${when.slice(0, 10)})`,
          timestamp: when,
        },
        when,
        index,
      ),
    );
  }

  for (const note of corpus.notes) {
    const paragraphs = splitParagraphs(note.body);
    paragraphs.forEach((paragraph, i) => {
      const text = `Meeting note — ${note.title} (${note.date})\n\n${paragraph}`;
      chunks.push(
        makeChunk(
          `ch_note_${note.id}_${i}`,
          "client",
          text,
          {
            system: "notes",
            kind: "meeting-note",
            id: paragraphs.length > 1 ? `${note.id}#${i}` : note.id,
            label: `Meeting note: ${note.title} (${note.date})`,
            timestamp: `${note.date}T00:00:00.000Z`,
          },
          `${note.date}T00:00:00.000Z`,
          index,
        ),
      );
    });
  }

  for (const plan of corpus.plans) {
    const paragraphs = splitParagraphs(plan.body);
    paragraphs.forEach((paragraph, i) => {
      const text = `Planning document — ${plan.title} (updated ${plan.updated})\n\n${paragraph}`;
      chunks.push(
        makeChunk(
          `ch_plan_${plan.id}_${i}`,
          "client",
          text,
          {
            system: "planning",
            kind: plan.kind,
            id: paragraphs.length > 1 ? `${plan.id}#${i}` : plan.id,
            label: `Plan: ${plan.title}`,
            timestamp: `${plan.updated}T00:00:00.000Z`,
          },
          `${plan.updated}T00:00:00.000Z`,
          index,
        ),
      );
    });
  }

  for (const doc of corpus.firmDocs) {
    const paragraphs = splitParagraphs(doc.body);
    paragraphs.forEach((paragraph, i) => {
      const text = `Firm document — ${doc.title}\n\n${paragraph}`;
      chunks.push(
        makeChunk(
          `ch_firm_${doc.id}_${i}`,
          "firm",
          text,
          {
            system: "firm",
            kind: doc.kind,
            id: paragraphs.length > 1 ? `${doc.id}#${i}` : doc.id,
            label: `Firm policy: ${doc.title}`,
            timestamp: `${doc.published}T00:00:00.000Z`,
          },
          `${doc.published}T00:00:00.000Z`,
          index,
        ),
      );
    });
  }

  return chunks;
}
