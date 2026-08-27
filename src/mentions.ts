/**
 * Which clients a piece of text is about.
 *
 * Two sources of truth, and they disagree often enough to matter. Structural
 * signals (To, Cc, attendees) are reliable but incomplete: the Okonkwo trust
 * email is addressed to two siblings and discusses a third. Textual signals
 * catch the third but are ambiguous: "James" names two different clients of
 * the same advisor.
 *
 * Ambiguity resolves outward, not inward. A bare "Chen" marks the chunk as
 * being about both Chens, which makes it cross-client and forces the fence to
 * deal with it. Guessing which Chen was meant is how a briefing ends up
 * asserting one spouse's holdings as the other's.
 */

import type { ClientId } from "./types.ts";
import { CLIENTS } from "./corpus/roster.ts";
import type { ClientSeed } from "./corpus/roster.ts";

export type MentionIndex = {
  /** Surface forms, longest first, each mapped to the clients it can mean. */
  forms: Array<{ form: string; pattern: RegExp; clients: ClientId[] }>;
  byEmail: Map<string, ClientId>;
};

function addForm(into: Map<string, Set<ClientId>>, form: string, client: ClientId): void {
  const key = form.toLowerCase();
  const existing = into.get(key);
  if (existing === undefined) into.set(key, new Set([client]));
  else existing.add(client);
}

export function buildMentionIndex(clients: readonly ClientSeed[] = CLIENTS): MentionIndex {
  const collected = new Map<string, Set<ClientId>>();
  const byEmail = new Map<string, ClientId>();

  for (const client of clients) {
    byEmail.set(client.email.toLowerCase(), client.id);
    addForm(collected, `${client.first} ${client.last}`, client.id);
    addForm(collected, client.last, client.id);
    addForm(collected, client.first, client.id);
    // "James W." disambiguates where "James" cannot.
    addForm(collected, `${client.first} ${client.last.charAt(0)}.`, client.id);
  }

  const forms = [...collected.entries()]
    .map(([form, ids]) => ({
      form,
      // Whole-word match. The trailing initial form ends in a period, which is
      // not a word character, so the boundary goes after the letter.
      pattern: new RegExp(`\\b${escapeRegExp(form)}(?![\\p{L}\\p{N}])`, "giu"),
      clients: [...ids].sort(),
    }))
    .sort((a, b) => b.form.length - a.form.length);

  return { forms, byEmail };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Clients named in the text. A longer form wins the characters it covers, so
 * "Margaret Chen" resolves to Margaret alone while a bare "Chen" stays
 * ambiguous and resolves to both.
 */
export function detectMentions(text: string, index: MentionIndex): ClientId[] {
  const lower = text.toLowerCase();
  const claimed: Array<[number, number]> = [];
  const found = new Set<ClientId>();

  // Email addresses first, and they keep their characters. An address
  // contains a surname, so letting a name rule match inside one turns
  // ngozi.okonkwo@example.test into a mention of all three Okonkwos.
  for (const [email, client] of index.byEmail) {
    let at = lower.indexOf(email);
    while (at !== -1) {
      claimed.push([at, at + email.length]);
      found.add(client);
      at = lower.indexOf(email, at + email.length);
    }
  }

  for (const { pattern, clients } of index.forms) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (claimed.some(([s, e]) => start < e && end > s)) continue;
      claimed.push([start, end]);
      for (const client of clients) found.add(client);
    }
  }

  return [...found].sort();
}

/** Map email addresses from a header or attendee list onto client ids. */
export function clientsForEmails(emails: readonly string[], index: MentionIndex): ClientId[] {
  const found = new Set<ClientId>();
  for (const email of emails) {
    const client = index.byEmail.get(email.toLowerCase());
    if (client !== undefined) found.add(client);
  }
  return [...found].sort();
}
