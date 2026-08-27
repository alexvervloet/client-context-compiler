/**
 * The vocabulary the compiler works in.
 *
 * Two fields carry most of the weight. `Chunk.clients` lists every client a
 * piece of text is about, which is what makes cross-client contamination
 * detectable at all. `SourceRef` is what an auditor clicks to check a claim.
 */

export type ClientId = string;
export type AdvisorId = string;

/** Systems a wealth-management firm already runs. */
export type SourceSystem = "crm" | "gmail" | "gcal" | "notes" | "planning" | "firm";

/** A pointer back to the record a claim came from. */
export type SourceRef = {
  system: SourceSystem;
  /** Record type within the system: "contact", "thread", "event", "policy". */
  kind: string;
  /** Native id in that system. */
  id: string;
  /** What a person reads in a citation list. */
  label: string;
  /** ISO 8601. Absent for records with no meaningful date, such as policies. */
  timestamp?: string;
  /** Deep link into the source system, when one exists. */
  url?: string;
};

/** The citation key that appears in model output: "gmail:thread/18f2c". */
export function refKey(ref: SourceRef): string {
  return `${ref.system}:${ref.kind}/${ref.id}`;
}

/**
 * Which memory a chunk belongs to.
 *
 * firm         — policy, product shelf, house view. Shared by everyone.
 * client       — one client's history. The layer that can leak.
 * conversation — what the advisor and the agent said in this session.
 */
export type MemoryLayer = "firm" | "client" | "conversation";

export const MEMORY_LAYERS: readonly MemoryLayer[] = ["firm", "client", "conversation"];

export type Chunk = {
  id: string;
  layer: MemoryLayer;
  text: string;
  ref: SourceRef;
  /** ISO 8601. Firm-layer chunks use the date the policy was published. */
  timestamp: string;
  /**
   * Every client this text discusses or is addressed to. Empty for firm-layer
   * text. Two entries means the chunk is shared, and the fence has to decide
   * what to do with it.
   */
  clients: ClientId[];
  /** Estimated tokens. See tokens.ts for what "estimated" is worth here. */
  tokens: number;
};

export type TaskKind =
  | "daily-briefing"
  | "meeting-prep"
  | "post-meeting-followup"
  | "compliance-review";

export const TASK_KINDS: readonly TaskKind[] = [
  "daily-briefing",
  "meeting-prep",
  "post-meeting-followup",
  "compliance-review",
];

export type Advisor = {
  id: AdvisorId;
  name: string;
  /** Clients this advisor may see at all. Authorization, not entanglement. */
  clientIds: ClientId[];
};

export type Client = {
  id: ClientId;
  /** Display name, e.g. "Margaret Chen". */
  name: string;
  /** Households let two clients legitimately share an address and a thread. */
  householdId: string;
  advisorId: AdvisorId;
};

export type CompileRequest = {
  task: TaskKind;
  clientId: ClientId;
  advisorId: AdvisorId;
  budgetTokens: number;
  /** Fixed clock, so a compile is reproducible. ISO 8601. */
  now: string;
  /** Free-text steer, for tasks that take one. */
  query?: string;
};

export type DropReason =
  /** The window filled up before this chunk's turn. */
  | "over-budget"
  /** The chunk names a client other than the one being compiled for. */
  | "cross-client"
  /** The advisor is not permitted to see this client at all. */
  | "not-authorized"
  /** Retrieval scored it below the floor. */
  | "below-relevance"
  /** Same text already admitted from another source. */
  | "duplicate"
  /** The layer had already spent its share of the budget. */
  | "layer-quota";

export type ManifestEntry =
  | {
      admitted: true;
      chunkId: string;
      ref: SourceRef;
      layer: MemoryLayer;
      tokens: number;
      score: number;
      /** Set when a shared chunk was admitted with other clients masked out. */
      redactedClients?: ClientId[];
    }
  | {
      admitted: false;
      chunkId: string;
      ref: SourceRef;
      layer: MemoryLayer;
      tokens: number;
      score: number;
      reason: DropReason;
      detail?: string;
    };

export type LayerStat = { admitted: number; dropped: number; tokens: number };

export type Manifest = {
  request: CompileRequest;
  budgetTokens: number;
  usedTokens: number;
  candidateCount: number;
  entries: ManifestEntry[];
  layers: Record<MemoryLayer, LayerStat>;
};

export type CompiledContext = {
  /** The window handed to the model. */
  text: string;
  manifest: Manifest;
  /** Every citation key the model is allowed to use, and what it points at. */
  citable: Map<string, SourceRef>;
};
