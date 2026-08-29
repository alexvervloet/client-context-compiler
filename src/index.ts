/**
 * The public surface.
 *
 * Everything re-exported here is meant to be called from outside. Everything
 * else in `src/` is implementation and will move without warning: the fence's
 * verdict shapes, the mention resolver, the packer, the retriever. If you find
 * yourself importing from a deep path, that is a gap in this file worth
 * raising rather than a licence to reach in.
 *
 * The shortest useful program:
 *
 *   import { makeCompiler } from "client-context-compiler";
 *
 *   const compiler = await makeCompiler({ chunks, directory });
 *   const { text, manifest, citable } = await compiler.compile({
 *     task: "meeting-prep",
 *     clientId: "cl_8812",
 *     advisorId: "adv_reyes",
 *     budgetTokens: 12000,
 *     now: new Date().toISOString(),
 *   });
 *
 * `text` goes to the model. `manifest` goes to the audit log. `citable` is
 * what you validate the model's citations against, and `extractCitations`
 * does that for you.
 */

// ---------------------------------------------------------------- compiling

export { makeCompiler, authorizedFor } from "./compile.ts";
export type { Compiler, CompilerOptions } from "./compile.ts";

// ------------------------------------------------------- requests and results

export type {
  AdvisorId,
  Chunk,
  ClientId,
  CompileRequest,
  CompiledContext,
  Directory,
  DirectoryEntry,
  DropReason,
  LayerStat,
  Manifest,
  ManifestEntry,
  MemoryLayer,
  Mention,
  SourceRef,
  SourceSystem,
  TaskKind,
} from "./types.ts";

export { MEMORY_LAYERS, TASK_KINDS, refKey } from "./types.ts";

// ------------------------------------------------------------------ sessions

export { conversationChunks, newSession, recordTurn } from "./session.ts";
export type { Session, Turn, TurnRole } from "./session.ts";

// ------------------------------------------------------------------- policy

/**
 * `strict` refuses any passage naming another client. `redact` additionally
 * masks a client mentioned in passing in a record somebody else owns. Neither
 * admits a record another client is party to. See the README for why that
 * distinction is narrower than it sounds.
 */
export type { FencePolicy } from "./fence.ts";

// --------------------------------------------------------------- generation

export { answer, buildPrompt, extractCitations } from "./answer.ts";
export type { Answer, AnswerOptions, Prompt } from "./answer.ts";

// ------------------------------------------------------------------ routing

export { PRICING, estimateCostUsd, routeFor } from "./route.ts";
export type { Effort, ModelId, Route } from "./route.ts";

// -------------------------------------------------------------- token budget

export { estimateTokens, measureEnvelopeTokens, measureEstimatorError } from "./tokens.ts";
export type { EstimatorError } from "./tokens.ts";

// --------------------------------------------------------- extension points

/**
 * Bring your own embedding model. `resolveEmbedder` picks the real one when a
 * key is present and a loud mock when it is not.
 */
export { cosine, makeMockEmbedder, makeVoyageEmbedder, resolveEmbedder } from "./embed.ts";
export type { Embedder } from "./embed.ts";

/**
 * Turning source records into chunks. Supplied for the bundled corpus shapes;
 * a real connector will have its own, and only has to produce `Chunk` values
 * with `owners` and `mentions` filled in honestly.
 */
export { buildChunk, normalize } from "./normalize.ts";
export { buildMentionIndex } from "./mentions.ts";
export type { MentionIndex } from "./mentions.ts";
