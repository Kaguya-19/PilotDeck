/** Input shared by all session-title providers. */
export type SessionTitleInput = {
  text: string;
  sessionId: string;
  turnId: string;
  signal: AbortSignal;
  /** Durable transcript sequence(s) represented by this title input. */
  messageSequences?: readonly number[];
};

export type SessionTitleModelProvenance = {
  provider: string;
  model: string;
};

/**
 * DSH-style Definition for session title generation.
 *
 * The provider only proposes a title. Session metadata and its durable
 * projection remain owned by the host Session/Turn composition.
 */
export type SessionTitlePort = {
  /** Stable provider identity for diagnostics and future provenance fields. */
  readonly providerId: string;
  /** Exact auxiliary model route, when this provider is model-backed. */
  readonly modelProvenance?: SessionTitleModelProvenance;
  generate(input: SessionTitleInput): Promise<string | null>;
  /** Optional generation-level cleanup for provider-owned resources. */
  dispose?: () => void | Promise<void>;
};
