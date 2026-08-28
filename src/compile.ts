/**
 * The whole pipeline, in one call.
 *
 * Corpus to chunks to index once; request to window many times. Building the
 * index is the expensive half and it does not depend on who is asking.
 */

import type {
  Chunk,
  ClientId,
  CompileRequest,
  CompiledContext,
  Directory,
  DirectoryEntry,
  TaskKind,
} from "./types.ts";
import { generateCorpus } from "./corpus/generate.ts";
import type { Corpus } from "./corpus/shapes.ts";
import { CLIENTS } from "./corpus/roster.ts";
import { normalize } from "./normalize.ts";
import { buildMentionIndex } from "./mentions.ts";
import type { MentionIndex } from "./mentions.ts";
import { resolveEmbedder } from "./embed.ts";
import type { Embedder } from "./embed.ts";
import { buildIndex, search } from "./retrieve.ts";
import type { SearchIndex } from "./retrieve.ts";
import { pack } from "./pack.ts";
import { conversationChunks } from "./session.ts";
import type { Session } from "./session.ts";
import type { FencePolicy } from "./fence.ts";

/**
 * What each task actually needs to see, as a retrieval query.
 *
 * These are deliberately about the shape of the answer rather than the client.
 * The client filter has already happened; asking the embedder to also match on
 * the client's name just buries the topical signal under twelve copies of a
 * surname.
 */
const TASK_QUERIES: Record<TaskKind, string> = {
  "daily-briefing":
    "open items, unanswered questions, anything that changed this week, deadlines in the next thirty days",
  "meeting-prep":
    "open items from the previous meeting, questions raised by email since, upcoming deadlines, current allocation and risk rating",
  "post-meeting-followup":
    "what was agreed at the most recent meeting, action items, who owes whom what and by when",
  "compliance-review":
    "risk tolerance on file and when it was reviewed, KYC review dates, suitability of recent recommendations, documentation of advice given",
};

export type CompilerOptions = {
  /**
   * Chunks to serve. Supply these to run against a real firm's data; the
   * connector is yours, and `normalize` is only one way to produce them.
   */
  chunks?: Chunk[];
  /**
   * Who the clients are and who advises them. Required alongside `chunks`;
   * defaults to the synthetic roster otherwise.
   */
  directory?: Directory;
  /** The bundled synthetic firm. Ignored when `chunks` is supplied. */
  corpus?: Corpus;
  embedder?: Embedder;
  policy?: FencePolicy;
  seed?: number;
};

export type Compiler = {
  /**
   * A session is optional. When one is supplied, its turns become the
   * conversation layer and are fenced exactly like retrieved records: a turn
   * about another client does not enter this window, whatever it says.
   */
  compile(request: CompileRequest, session?: Session): Promise<CompiledContext>;
  readonly index: SearchIndex;
  readonly mentions: MentionIndex;
  readonly embedder: Embedder;
};

export async function makeCompiler(options: CompilerOptions = {}): Promise<Compiler> {
  const directory: Directory = options.directory ?? { clients: CLIENTS };
  const mentions = buildMentionIndex(directory.clients);
  const chunks =
    options.chunks ?? normalize(options.corpus ?? generateCorpus(options.seed), mentions);
  const embedder = options.embedder ?? resolveEmbedder();
  const index = await buildIndex(chunks, embedder);
  const policy = options.policy ?? "strict";

  const lookup = (clientId: ClientId): DirectoryEntry => {
    const found = directory.clients.find((c) => c.id === clientId);
    if (found === undefined) throw new Error(`unknown client: ${clientId}`);
    return found;
  };

  return {
    index,
    mentions,
    embedder,
    async compile(request, session) {
      const client = lookup(request.clientId);
      if (session !== undefined && session.advisorId !== request.advisorId) {
        throw new Error(
          `session ${session.id} belongs to ${session.advisorId}, not ${request.advisorId}`,
        );
      }

      if (client.advisorId !== request.advisorId) {
        // Not a fence problem. This advisor has no business here at all.
        throw new Error(
          `advisor ${request.advisorId} does not advise ${request.clientId}; ` +
            "the request is rejected before any retrieval happens",
        );
      }

      const query = [TASK_QUERIES[request.task], request.query ?? ""].join(" ").trim();
      const candidates = await search(index, {
        query,
        subject: request.clientId,
        now: request.now,
        topK: 120,
      });

      return pack({
        request,
        candidates,
        conversation: session === undefined ? [] : conversationChunks(session, mentions),
        authorized: authorizedFor(request.advisorId, directory),
        index: mentions,
        policy,
        clientName: `${client.first} ${client.last}`,
      });
    },
  };
}

/** Every client on an advisor's book. */
export function authorizedFor(
  advisorId: string,
  directory: Directory = { clients: CLIENTS },
): ReadonlySet<ClientId> {
  return new Set(
    directory.clients.filter((c) => c.advisorId === advisorId).map((c) => c.id),
  );
}
