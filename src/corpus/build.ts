/**
 * Builders for source records, so the generated filler and the hand-written
 * traps produce byte-identical shapes. Anything that reads a trap record has
 * to work on a generated one too, which is the only way the traps prove
 * anything.
 */

import type {
  CalendarEvent,
  CrmContact,
  FirmDocument,
  GmailMessage,
  GmailThread,
  MeetingNote,
  PlanningDocument,
} from "./shapes.ts";
import type { ClientSeed } from "./roster.ts";
import { FIRM_DOMAIN } from "./roster.ts";

export function contactFrom(client: ClientSeed, lastContacted: string): CrmContact {
  return {
    id: client.crmId,
    properties: {
      firstname: client.first,
      lastname: client.last,
      email: client.email,
      phone: `+1-555-01${client.crmId.slice(-2)}`,
      lifecyclestage: "customer",
      household_id: client.householdId,
      advisor_owner: client.advisorId,
      portfolio_value_usd: String(client.portfolioUsd),
      risk_tolerance: client.risk,
      risk_tolerance_reviewed: client.riskReviewed,
      kyc_review_due: client.kycDue,
      notes_last_contacted: lastContacted,
    },
    createdAt: "2019-04-02T09:00:00.000Z",
    updatedAt: `${client.riskReviewed}T16:22:00.000Z`,
  };
}

export type MessageSpec = {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  date: string;
  body: string;
};

export function threadFrom(id: string, specs: MessageSpec[]): GmailThread {
  const messages: GmailMessage[] = specs.map((spec, index) => {
    const headers = [
      { name: "From", value: spec.from },
      { name: "To", value: spec.to.join(", ") },
      { name: "Subject", value: index === 0 ? spec.subject : `Re: ${spec.subject}` },
      { name: "Date", value: new Date(spec.date).toUTCString() },
      { name: "Message-ID", value: `<${id}.${index}@${FIRM_DOMAIN}>` },
    ];
    if (spec.cc !== undefined && spec.cc.length > 0) {
      headers.splice(2, 0, { name: "Cc", value: spec.cc.join(", ") });
    }
    return {
      id: `${id}m${index}`,
      threadId: id,
      internalDate: String(Date.parse(spec.date)),
      snippet: spec.body.slice(0, 100).replace(/\s+/g, " "),
      payload: { headers, body: { data: spec.body } },
    };
  });
  return { id, historyId: String(1_000_000 + specs.length), messages };
}

export type EventSpec = {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;
  durationMinutes: number;
  organizerEmail: string;
  attendeeEmails: string[];
  status?: CalendarEvent["status"];
};

export function eventFrom(spec: EventSpec): CalendarEvent {
  const startMs = Date.parse(spec.start);
  const event: CalendarEvent = {
    id: spec.id,
    summary: spec.summary,
    start: { dateTime: new Date(startMs).toISOString(), timeZone: "America/Los_Angeles" },
    end: {
      dateTime: new Date(startMs + spec.durationMinutes * 60_000).toISOString(),
      timeZone: "America/Los_Angeles",
    },
    attendees: [
      { email: spec.organizerEmail, organizer: true, responseStatus: "accepted" },
      ...spec.attendeeEmails.map((email) => ({
        email,
        responseStatus: "accepted" as const,
      })),
    ],
    status: spec.status ?? "confirmed",
  };
  if (spec.description !== undefined) event.description = spec.description;
  if (spec.location !== undefined) event.location = spec.location;
  return event;
}

export function noteFrom(
  id: string,
  authorEmail: string,
  attendeeEmails: string[],
  date: string,
  title: string,
  body: string,
): MeetingNote {
  return { id, authorEmail, attendeeEmails, date, title, body };
}

export function planFrom(
  id: string,
  clientEmails: string[],
  title: string,
  kind: PlanningDocument["kind"],
  updated: string,
  body: string,
): PlanningDocument {
  return { id, clientEmails, title, kind, updated, body };
}

export function firmDocFrom(
  id: string,
  title: string,
  kind: FirmDocument["kind"],
  published: string,
  body: string,
): FirmDocument {
  return { id, title, kind, published, body };
}
