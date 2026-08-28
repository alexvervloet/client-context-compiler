/**
 * The conversation layer.
 *
 * This is the layer that leaks in real products, and it leaks for a reason
 * that has nothing to do with retrieval. An advisor does meeting prep for one
 * client at nine, another at nine fifteen, and asks "what about the September
 * obligation?" without saying whose. The retriever is not involved. The
 * previous answer is simply still sitting in the conversation, and it belongs
 * to somebody else.
 *
 * A turn is not searchable text, so mention detection often finds nothing in
 * it: "what about that?" names no one. What a turn does have is a subject, and
 * recording it is the whole defence. Turns carry their subject as structural
 * ownership, which is the same field the fence already uses for a meeting note
 * whose title refuses to commit to anyone.
 */

import type { AdvisorId, Chunk, ClientId } from "./types.ts";
import { findMentions, mentionedClients } from "./mentions.ts";
import type { MentionIndex } from "./mentions.ts";
import { buildMentionIndex } from "./mentions.ts";
import { estimateTokens } from "./tokens.ts";

export type TurnRole = "advisor" | "assistant";

export type Turn = {
  id: string;
  role: TurnRole;
  text: string;
  /**
   * Which client this turn was about. Recorded at the time, never inferred
   * afterwards from the words, because the words frequently do not say.
   */
  clientId: ClientId;
  /** ISO 8601. */
  at: string;
};

export type Session = {
  id: string;
  advisorId: AdvisorId;
  /** Oldest first. */
  turns: Turn[];
};

export function newSession(id: string, advisorId: AdvisorId): Session {
  return { id, advisorId, turns: [] };
}

/** Returns a new session. Turn history is append-only by construction. */
export function recordTurn(session: Session, turn: Turn): Session {
  return { ...session, turns: [...session.turns, turn] };
}

const ROLE_LABEL: Record<TurnRole, string> = {
  advisor: "The advisor said",
  assistant: "You replied",
};

/**
 * Session turns as chunks, oldest first.
 *
 * The packer walks the conversation layer newest first and stops when the
 * layer's share of the budget is gone, so a long session drops its oldest
 * turns rather than its most recent ones.
 */
export function conversationChunks(
  session: Session,
  index: MentionIndex = buildMentionIndex(),
): Chunk[] {
  return session.turns.map((turn) => {
    const text = [
      `Earlier in this session — ${ROLE_LABEL[turn.role]} (${turn.at.slice(0, 16).replace("T", " ")})`,
      "",
      turn.text,
    ].join("\n");

    const mentions = findMentions(text, index);
    return {
      id: `ch_turn_${turn.id}`,
      layer: "conversation",
      text,
      ref: {
        system: "session",
        kind: "turn",
        id: turn.id,
        label: `This session: ${turn.role} turn at ${turn.at.slice(11, 16)}`,
        timestamp: turn.at,
      },
      timestamp: turn.at,
      clients: [...new Set([turn.clientId, ...mentionedClients(mentions)])].sort(),
      owners: [turn.clientId],
      mentions,
      tokens: estimateTokens(text),
    };
  });
}
