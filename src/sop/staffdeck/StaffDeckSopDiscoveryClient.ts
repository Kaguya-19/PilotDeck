import type { StaffDeckSopDiscoveryPort as DiscoveryClient, StaffDeckSopRouteResult } from "./types.js";

type FetchLike = typeof fetch;

export class StaffDeckSopDiscoveryClientError extends Error {
  readonly name = "StaffDeckSopDiscoveryClientError";

  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** Authenticated adapter for StaffDeck's native SOP route protocol. */
export class StaffDeckSopDiscoveryClient implements DiscoveryClient {
  private readonly endpoint: string;

  constructor(
    endpoint: string,
    private readonly agentId: string,
    private readonly apiKey: string,
    private readonly options: { fetch?: FetchLike; timeoutMs?: number; path?: string } = {},
  ) {
    this.endpoint = endpoint.replace(/\/+$/u, "");
  }

  async route(input: Parameters<DiscoveryClient["route"]>[0]): Promise<StaffDeckSopRouteResult> {
    const timeoutController = this.options.timeoutMs === undefined ? undefined : new AbortController();
    const timeoutId = timeoutController && setTimeout(
      () => timeoutController.abort(new DOMException("StaffDeck SOP discovery request timed out.", "TimeoutError")),
      this.options.timeoutMs,
    );
    const signal = timeoutController && input.signal
      ? AbortSignal.any([timeoutController.signal, input.signal])
      : timeoutController?.signal ?? input.signal;
    try {
      const fetcher = this.options.fetch ?? fetch;
      const response = await fetcher(
        `${this.endpoint}${this.options.path ?? `/agents/${encodeURIComponent(this.agentId)}/sops:route`}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            message: input.message,
            model_source: "pilotdeck_host",
            session_id: input.sessionId,
            ...(input.activeSopId ? { active_sop_id: input.activeSopId } : {}),
            ...(input.activeStepId ? { active_step_id: input.activeStepId } : {}),
            ...(input.slots ? { slots: input.slots } : {}),
            ...(input.pendingTasks ? { pending_tasks: input.pendingTasks } : {}),
            ...(input.awaitingInput ? { awaiting_input: input.awaitingInput } : {}),
          }),
          signal,
        },
      );
      const payload = await readJson(response);
      if (!response.ok) {
        const code = isRecord(payload) && typeof payload.code === "string" ? payload.code : "SOP_DISCOVERY_FAILED";
        throw new StaffDeckSopDiscoveryClientError(code, `StaffDeck SOP discovery returned HTTP ${response.status}.`);
      }
      if (!isRecord(payload) || typeof payload.decision !== "string") {
        throw new StaffDeckSopDiscoveryClientError("SOP_DISCOVERY_PROTOCOL", "StaffDeck SOP discovery returned an invalid route response.");
      }
      return {
        decision: payload.decision,
        candidateSopIds: Array.isArray(payload.candidate_sop_ids)
          ? payload.candidate_sop_ids.filter((value): value is string => typeof value === "string")
          : undefined,
        selectedSopId: stringOrNull(payload.selected_sop_id),
        targetStepId: stringOrNull(payload.target_step_id),
        confidence: typeof payload.confidence === "number" ? payload.confidence : undefined,
        userIntent: stringOrNull(payload.user_intent),
        reason: stringOrNull(payload.reason),
        clarificationQuestion: stringOrNull(payload.clarification_question),
      };
    } catch (error) {
      if (error instanceof StaffDeckSopDiscoveryClientError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new StaffDeckSopDiscoveryClientError("SOP_DISCOVERY_UNAVAILABLE", `StaffDeck SOP discovery request failed: ${reason}`);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === "string" && value.length > 0 ? value : undefined;
}
