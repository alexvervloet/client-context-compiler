/**
 * Source records in the shapes the real platforms return.
 *
 * These are trimmed to the fields a context pipeline actually reads, but the
 * field names and nesting match the live APIs: HubSpot wraps everything in
 * `properties`, Gmail hands back a thread of messages with RFC-2822 headers in
 * a `payload.headers` array, Google Calendar puts attendees in an array of
 * objects with `responseStatus`. Normalization has to deal with all three
 * being different, which is the point of keeping them different here.
 */

/** HubSpot CRM contact. GET /crm/v3/objects/contacts/{id} */
export type CrmContact = {
  id: string;
  properties: {
    firstname: string;
    lastname: string;
    email: string;
    phone: string;
    lifecyclestage: string;
    /** Custom properties. A real firm has dozens; these are the ones we read. */
    household_id: string;
    advisor_owner: string;
    portfolio_value_usd: string;
    risk_tolerance: "conservative" | "moderate" | "growth" | "aggressive";
    risk_tolerance_reviewed: string;
    kyc_review_due: string;
    notes_last_contacted: string;
  };
  createdAt: string;
  updatedAt: string;
};

/** Gmail message header, as returned inside payload.headers. */
export type GmailHeader = { name: string; value: string };

/** Gmail message. users.messages.get, format=full, body already decoded. */
export type GmailMessage = {
  id: string;
  threadId: string;
  /** Epoch milliseconds, as a string. Gmail really does this. */
  internalDate: string;
  snippet: string;
  payload: {
    headers: GmailHeader[];
    /** Decoded text/plain body. The API base64url-encodes this. */
    body: { data: string };
  };
};

/** Gmail thread. users.threads.get */
export type GmailThread = {
  id: string;
  historyId: string;
  messages: GmailMessage[];
};

/** Google Calendar event. events.get */
export type CalendarEvent = {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees: {
    email: string;
    displayName?: string;
    organizer?: boolean;
    responseStatus: "accepted" | "declined" | "tentative" | "needsAction";
  }[];
  status: "confirmed" | "tentative" | "cancelled";
};

/**
 * A meeting note. No standard API for this; every firm has its own field in
 * whatever tool the advisor types into. Modelled as free markdown with a small
 * header, which is what those exports look like in practice.
 */
export type MeetingNote = {
  id: string;
  authorEmail: string;
  /** Email addresses of the clients discussed. Often wrong in real exports. */
  attendeeEmails: string[];
  date: string;
  title: string;
  body: string;
};

/** A planning document: retirement projection, education funding, estate memo. */
export type PlanningDocument = {
  id: string;
  clientEmails: string[];
  title: string;
  kind: "retirement" | "education" | "estate" | "tax";
  updated: string;
  body: string;
};

/** Firm-level knowledge. Not about any client. */
export type FirmDocument = {
  id: string;
  title: string;
  kind: "policy" | "product" | "house-view" | "compliance";
  published: string;
  body: string;
};

/** Everything the generator emits. */
export type Corpus = {
  seed: number;
  firmName: string;
  contacts: CrmContact[];
  threads: GmailThread[];
  events: CalendarEvent[];
  notes: MeetingNote[];
  plans: PlanningDocument[];
  firmDocs: FirmDocument[];
};

/** Read a header out of a Gmail message, case-insensitively. */
export function header(message: GmailMessage, name: string): string {
  const wanted = name.toLowerCase();
  for (const h of message.payload.headers) {
    if (h.name.toLowerCase() === wanted) return h.value;
  }
  return "";
}

/** Split an address list header into bare email addresses. */
export function addresses(headerValue: string): string[] {
  if (headerValue.trim() === "") return [];
  return headerValue
    .split(",")
    .map((part) => {
      const angle = /<([^>]+)>/.exec(part);
      return (angle?.[1] ?? part).trim().toLowerCase();
    })
    .filter((value) => value !== "");
}
