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
 *
 * Matching happens over a folded copy of the text, never the raw bytes. A name
 * a person reads as "Margaret Chen" can be written a dozen ways that are not
 * that string: a zero-width space inside it, a Cyrillic "с" for the Latin one,
 * a soft hyphen, an accent, a fullwidth form. All of them are invisible or
 * near-invisible to a reader and to a model, and all of them used to score
 * zero mentions and sail through the fence. Folding is what makes the
 * comparison happen on what the text *looks like* rather than how it is
 * encoded.
 *
 * Offsets survive the fold. Redaction masks spans of the original string, so
 * every folded character remembers where it came from and a mention's
 * start/end always index the text the caller passed in.
 */

import type { ClientId, DirectoryEntry, Mention } from "./types.ts";
import { CLIENTS } from "./corpus/roster.ts";

export type MentionIndex = {
  /** Surface forms, longest first, each mapped to the clients it can mean. */
  forms: { form: string; pattern: RegExp; clients: ClientId[] }[];
  byEmail: Map<string, ClientId>;
};

function addForm(into: Map<string, Set<ClientId>>, form: string, client: ClientId): void {
  // Folded, because the text side is folded too and the two have to agree. A
  // directory with "Muller" in it should match prose that writes "Muller".
  const key = fold(form).text;
  const existing = into.get(key);
  if (existing === undefined) into.set(key, new Set([client]));
  else existing.add(client);
}

export function buildMentionIndex(
  clients: readonly DirectoryEntry[] = CLIENTS,
): MentionIndex {
  const collected = new Map<string, Set<ClientId>>();
  const byEmail = new Map<string, ClientId>();

  for (const client of clients) {
    byEmail.set(fold(client.email).text, client.id);
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
 * Letters from other scripts that a reader cannot tell from a Latin one.
 *
 * Not the full Unicode confusables table, which is thousands of entries and
 * mostly irrelevant here. This is the Cyrillic and Greek subset that can be
 * typed on an ordinary keyboard layout and that spells a Latin-alphabet name
 * convincingly. Keys are lowercase, because folding lowercases first.
 */
const CONFUSABLES = new Map<string, string>(
  Object.entries({
    // Cyrillic
    "\u0430": "a", "\u0432": "b", "\u0435": "e", "\u0433": "r", "\u04bb": "h",
    "\u0456": "i", "\u0458": "j", "\u043a": "k", "\u043c": "m", "\u043d": "h",
    "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0442": "t", "\u0443": "y",
    "\u0445": "x", "\u0455": "s", "\u0501": "d", "\u051b": "q", "\u051d": "w",
    // Greek
    "\u03b1": "a", "\u03b2": "b", "\u03b5": "e", "\u03b7": "n", "\u03b9": "i",
    "\u03ba": "k", "\u03bd": "v", "\u03bf": "o", "\u03c1": "p", "\u03c3": "o",
    "\u03c4": "t", "\u03c5": "u", "\u03c7": "x", "\u03f2": "c",
  }),
);

export type Folded = {
  /** The comparison copy: lowercase, unaccented, single-script, no invisibles. */
  text: string;
  /**
   * `offsets[i]` is where folded character `i` started in the original, and
   * the final entry is the original length. A folded span [s, e) maps back to
   * the original span [offsets[s], offsets[e]), which deliberately swallows
   * any invisible character sitting on the boundary: masking a name has to
   * take the zero-width space hiding inside it too.
   */
  offsets: number[];
};

/**
 * Fold text for comparison, remembering where every character came from.
 *
 * Per character rather than over the whole string, because NFKC changes
 * length: the ligature "ﬁ" becomes two characters, and a whole-string
 * normalize would slide every offset after it.
 */
export function fold(text: string): Folded {
  const out: string[] = [];
  const offsets: number[] = [];
  let i = 0;

  while (i < text.length) {
    const codePoint = text.codePointAt(i);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);

    // Invisibles: zero-width spaces and joiners, the soft hyphen, bidi
    // controls, the byte-order mark. They survive NFKC, and a name with one
    // inside it is the whole attack.
    if (!/\p{Cf}/u.test(char)) {
      const folded = char
        .normalize("NFKC")
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toLowerCase();
      for (const piece of folded) {
        out.push(CONFUSABLES.get(piece) ?? piece);
        offsets.push(i);
      }
    }

    i += char.length;
  }

  offsets.push(text.length);
  return { text: out.join(""), offsets };
}

/**
 * Clients named in the text. A longer form wins the characters it covers, so
 * "Margaret Chen" resolves to Margaret alone while a bare "Chen" stays
 * ambiguous and resolves to both.
 */
export function findMentions(text: string, index: MentionIndex): Mention[] {
  const folded = fold(text);
  const mentions: Mention[] = [];
  const claimed: [number, number][] = [];

  const overlaps = (start: number, end: number): boolean =>
    claimed.some(([s, e]) => start < e && end > s);

  // Folded spans map back to the original before anything leaves this
  // function. Everything downstream, redaction most of all, edits the string
  // the caller passed in.
  const record = (start: number, end: number, candidates: ClientId[]): void => {
    claimed.push([start, end]);
    const from = folded.offsets[start] ?? 0;
    const to = folded.offsets[end] ?? text.length;
    mentions.push({ form: text.slice(from, to), start: from, end: to, candidates });
  };

  // Email addresses first, and they keep their characters. An address
  // contains a surname, so letting a name rule match inside one turns
  // ngozi.okonkwo@example.test into a mention of all three Okonkwos.
  for (const [email, client] of index.byEmail) {
    let at = folded.text.indexOf(email);
    while (at !== -1) {
      const end = at + email.length;
      record(at, end, [client]);
      at = folded.text.indexOf(email, end);
    }
  }

  for (const { pattern, clients } of index.forms) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(folded.text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (overlaps(start, end)) continue;
      record(start, end, [...clients]);
    }
  }

  return mentions.sort((a, b) => a.start - b.start);
}

/** Every client any mention could refer to. The coarse view. */
export function mentionedClients(mentions: readonly Mention[]): ClientId[] {
  const found = new Set<ClientId>();
  for (const mention of mentions) {
    for (const candidate of mention.candidates) found.add(candidate);
  }
  return [...found].sort();
}

export function detectMentions(text: string, index: MentionIndex): ClientId[] {
  return mentionedClients(findMentions(text, index));
}

/** Map email addresses from a header or attendee list onto client ids. */
export function clientsForEmails(emails: readonly string[], index: MentionIndex): ClientId[] {
  const found = new Set<ClientId>();
  for (const email of emails) {
    const client = index.byEmail.get(fold(email).text);
    if (client !== undefined) found.add(client);
  }
  return [...found].sort();
}
