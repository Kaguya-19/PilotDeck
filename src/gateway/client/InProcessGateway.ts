import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseAgentRunMode } from "../../agent/protocol/input.js";
import type { AgentEvent, AgentInput } from "../../agent/index.js";
import {
  type CanonicalMessage,
} from "../../model/index.js";
import type { SessionRouter } from "../SessionRouter.js";
import {
  type GatewaySessionPermissionGrantPort,
} from "../permission/GatewaySessionPermissionRuleSetRegistry.js";
import { AsyncQueue } from "../util/AsyncQueue.js";
import type {
  ChannelAttachment,
  GatewayCronController,
  Gateway,
  GatewayActiveTurnSnapshot,
  GatewayActiveTurnSnapshotInput,
  GatewayElicitationResponseInput,
  GatewayEvent,
  GatewayPermissionDecisionInput,
  GatewayRecordAgentStatusMessageInput,
  GatewaySessionPermissionGrantInput,
  GatewayServerInfo,
  GatewaySubmitTurnInput,
  GatewayCancelSteerInput,
  GatewayCancelSteerResult,
  GatewaySteerTurnInput,
  GatewaySteerTurnResult,
  ListSessionsInput,
  ListSessionsResult,
  NewSessionInput,
  PrepareWeixinLoginResult,
  AlwaysOnApplyInput,
  AlwaysOnApplyResult,
  AlwaysOnAbortInput,
  AlwaysOnAbortResult,
  AlwaysOnRerunPlanInput,
  AlwaysOnRerunPlanResult,
  ReloadConfigResult,
  WebDescribeProjectInput,
  WebListProjectsResult,
  WebProjectSummary,
  WebReadSessionMessagesInput,
  WebReadSessionMessagesResult,
  WebReadSubagentMessagesInput,
  WebReadSubagentMessagesResult,
  WebForkSessionInput,
  WebForkSessionResult,
  WebReplaceLastTurnInput,
  WebReplaceLastTurnResult,
  WebFinalizeLastTurnReplacementInput,
  WebFinalizeLastTurnReplacementResult,
  ProjectFilesListInput,
  ProjectFilesListResult,
  CommandsListInput,
  CommandsListResult,
  ModelCatalogListInput,
  ModelCatalogListResult,
  SessionModelInput,
  SessionModelSetInput,
  SessionModelResult,
} from "../protocol/types.js";
import type {
  InteractionConnectionBinding,
  InteractionReconnectPort,
} from "../../interaction/index.js";
import type {
  CronCreateInput,
  CronCreateResult,
  CronDeleteInput,
  CronDeleteResult,
  CronListInput,
  CronListResult,
  CronRunNowInput,
  CronRunNowResult,
  CronStopInput,
  CronStopResult,
  CronUpdateInput,
  CronUpdateResult,
} from "../../cron/protocol/types.js";
import {
  isPermissionMode,
  permissionSettingsToRuleSet,
  readPermissionSettings,
  type PermissionMode,
} from "../../permission/index.js";
import {
  GatewaySessionPermissionModeRegistry,
  type GatewaySessionPermissionModePort,
} from "../permission/GatewaySessionPermissionModeRegistry.js";
import { SkillManagerError, type SkillManager } from "../../extension/skills/index.js";
import { getPilotDeckInstallCommand } from "../../mcp/runtime/projectMcpSpec.js";
import type { AttachmentResolver } from "../../context/attachments/AttachmentResolver.js";
import type { AlwaysOnControlPort } from "../../always-on/protocol/AlwaysOnControlPort.js";
import type {
  SkillAddressInput,
  SkillCreateInput,
  SkillCreateResult,
  SkillDeleteInput,
  SkillDeleteResult,
  SkillImportInput,
  SkillImportResult,
  SkillReadResult,
  SkillScanInput,
  SkillScanResult,
  SkillValidateInput,
  SkillValidationResult,
  SkillWriteInput,
  SkillWriteResult,
  SkillsListInput,
  SkillsListResult,
} from "../../extension/skills/types.js";
import { createVisibleErrorStatusDetail } from "../../status/agentStatus.js";
import type { TelemetryClient } from "../../telemetry/index.js";
import { DialogGatewayError } from "../dialog/errors.js";
import { GatewayAttachmentTurnComposer } from "../dialog/GatewayAttachmentTurnComposer.js";
import type { GatewayAttachmentTurnComposerPort } from "../dialog/GatewayAttachmentTurnComposerPort.js";
import { GatewayAgentEventProjector } from "./GatewayAgentEventProjector.js";
import type { GatewayAgentEventProjectorPort } from "./GatewayAgentEventProjectorPort.js";
import { GatewayAgentEventTelemetryObserver } from "./GatewayAgentEventTelemetryObserver.js";
import type { GatewayAgentEventTelemetryObserverPort } from "./GatewayAgentEventTelemetryObserverPort.js";
import { GatewayToolResultArtifactStore } from "./GatewayToolResultArtifactStore.js";
import type { GatewayToolResultArtifactStorePort } from "./GatewayToolResultArtifactStorePort.js";
import type { GatewayTurnReplayStorePort } from "./GatewayTurnReplayStorePort.js";
import { GatewayTurnEventCoordinator } from "./GatewayTurnEventCoordinator.js";
import type { GatewayTurnEventCoordinatorPort } from "./GatewayTurnEventCoordinatorPort.js";
import { GatewayTurnTelemetryContextResolver } from "./GatewayTurnTelemetryContextResolver.js";
import type { GatewayTurnTelemetryContextResolverPort } from "./GatewayTurnTelemetryContextResolverPort.js";
import { GatewayTurnReplacementCoordinator } from "./GatewayTurnReplacementCoordinator.js";
import type { GatewayTurnReplacementCoordinatorPort } from "./GatewayTurnReplacementCoordinatorPort.js";
import { GatewayInteractionCoordinator } from "./GatewayInteractionCoordinator.js";
import type { GatewayInteractionCoordinatorPort } from "./GatewayInteractionCoordinatorPort.js";
import { GatewayTurnCompletionFence } from "./GatewayTurnCompletionFence.js";
import type { GatewayTurnCompletionFencePort } from "./GatewayTurnCompletionFencePort.js";
import { GatewayManualCompactionCoordinator } from "./GatewayManualCompactionCoordinator.js";
import type { GatewayManualCompactionCoordinatorPort } from "./GatewayManualCompactionCoordinatorPort.js";
import type { GatewayElicitationBus } from "../elicitation/GatewayElicitationBus.js";
import type { GatewayPermissionBus } from "../permission/GatewayPermissionBus.js";
import type { ResolvedUploadedAttachments, UploadedAttachmentResolverPort } from "../dialog/UploadedAttachmentResolverPort.js";
import { listProjectFiles } from "../dialog/projectFiles.js";

export { mapAgentEvent } from "./GatewayAgentEventProjector.js";

const PLAN_COMMAND_USAGE = "用法：/plan <任务>\n例如：/plan 设计一个新功能";
const COMPACT_COMMAND_USAGE = "用法：/compact";
const DEFAULT_REPLACEMENT_TRANSACTION_TIMEOUT_MS = 60_000;

export type InProcessGatewayOptions = {
  /** Absolute command used by the model to install bundled FunASR assets. */
  funasrInstallCommand?: string;
  /** Attachment turn-composition consumer wired by application composition. */
  attachmentTurnComposer?: GatewayAttachmentTurnComposerPort;
  /** Compatibility fallback for direct Gateway callers that do not compose a turn composer. */
  attachmentResolver?: AttachmentResolver;
  now?: () => Date;
  uuid?: () => string;
  serverInfo?: Partial<GatewayServerInfo>;
  cron?: GatewayCronController;
  /**
   * Web Phase 2 — pluggable session-history reader. Wired by
   * `createLocalGateway` so the in-process gateway can answer
   * `read_session_messages` without leaking transcript paths.
   */
  readSessionMessages?: (input: WebReadSessionMessagesInput) => Promise<WebReadSessionMessagesResult>;
  readSubagentMessages?: (input: WebReadSubagentMessagesInput) => Promise<WebReadSubagentMessagesResult>;
  forkSession?: (input: WebForkSessionInput) => Promise<WebForkSessionResult>;
  replaceLastTurn?: (input: WebReplaceLastTurnInput) => Promise<WebReplaceLastTurnResult>;
  finalizeLastTurnReplacement?: (
    input: WebFinalizeLastTurnReplacementInput,
  ) => Promise<WebFinalizeLastTurnReplacementResult>;
  /** Roll back a prepared edit that never reaches durable input acceptance. */
  replacementTransactionTimeoutMs?: number;
  recordAgentStatusMessage?: (input: GatewayRecordAgentStatusMessageInput) => Promise<{ recorded: boolean }>;
  /**
   * Web Phase 3 — pluggable project enumerator + describer.
   */
  listProjects?: () => Promise<WebListProjectsResult>;
  describeProject?: (input: WebDescribeProjectInput) => Promise<WebProjectSummary>;
  commandsList?: (input: CommandsListInput) => Promise<CommandsListResult>;
  modelCatalogList?: (input: ModelCatalogListInput) => Promise<ModelCatalogListResult>;
  sessionModelGet?: (input: SessionModelInput) => Promise<SessionModelResult>;
  sessionModelSet?: (input: SessionModelSetInput) => Promise<SessionModelResult>;
  sessionModelClear?: (input: SessionModelInput) => Promise<void>;
  resolveUploadedAttachments?: UploadedAttachmentResolverPort["resolve"];
  resolveTurnModelSelection?: (input: GatewaySubmitTurnInput) => Promise<{
    selection?: import("../protocol/types.js").ExplicitModelSelection;
    source: "turn" | "session" | "router" | "default";
  }>;
  /**
   * Pluggable config-reload handler wired by `createLocalGateway`.
   * When set, `reloadConfig()` delegates to this callback which owns
   * the PilotConfigStore + ProjectRuntimeRegistry lifecycle.
   */
  reloadConfig?: () => Promise<ReloadConfigResult>;
  prepareWeixinLogin?: () => Promise<PrepareWeixinLoginResult>;
  /**
   * Pluggable extension/MCP reload handler wired by `createLocalGateway`.
   * Unlike `reloadConfig`, this does not depend on `pilotdeck.yaml` changing.
   */
  reloadExtensions?: (input?: import("../protocol/types.js").ReloadExtensionsInput) => Promise<import("../protocol/types.js").ReloadExtensionsResult>;
  /**
   * Optional pre-turn hook that lets the host re-read disk config before
   * `submitTurn` resolves a session and starts streaming. Wired by
   * `createLocalGateway` to `configStore.reload("turn-start")` so that
   * a credential / model edit applied between turns is guaranteed to
   * take effect on the very next message even when fs watchers miss the
   * change (network mounts, debounce gaps, container snapshots).
   *
   * Cheap and singleton-deduped — `PilotConfigStore.reload` is a no-op
   * when the yaml hasn't changed and only re-runs the
   * invalidate-runtimes / mark-sessions-dirty path when something
   * actually moved.
   *
   * Failures are swallowed so a transient yaml read error does not
   * block in-progress chats; the existing snapshot remains in use.
   */
  refreshConfigBeforeTurn?: () => Promise<void>;
  /**
   * Authoritative skill CRUD manager for built-in, user, and project skills.
   * Wired by `createLocalGateway` so every host (CLI, TUI, Web UI bridge,
   * SDK) reads and writes the same skill directory the agent loads from.
   */
  skillManager?: SkillManager;
  dispatchHookForSession?: (sessionKey: string, event: string, payload: Record<string, unknown>) => void;
  /** Directory to persist large tool outputs for TUI/Web viewing. */
  toolResultsDir?: string;
  /** Application-selected best-effort result artifact provider. */
  toolResultArtifacts?: GatewayToolResultArtifactStorePort;
  /** Application-selected Agent-to-Gateway live-event projection provider. */
  agentEventProjector?: GatewayAgentEventProjectorPort;
  /** Application-selected Agent event telemetry observer. */
  agentEventTelemetryObserver?: GatewayAgentEventTelemetryObserverPort;
  /** Application-selected bounded volatile Gateway turn replay provider. */
  turnReplayStore?: GatewayTurnReplayStorePort;
  /** Application-selected live turn sink/replay coordinator. */
  turnEventCoordinator?: GatewayTurnEventCoordinatorPort;
  /** Application-selected host policy for classifying turn telemetry. */
  turnTelemetryContextResolver?: GatewayTurnTelemetryContextResolverPort;
  /** Application-selected volatile coordinator for last-turn replacement transactions. */
  turnReplacementCoordinator?: GatewayTurnReplacementCoordinatorPort;
  /** Application-selected owner for reconnectable Gateway interaction state. */
  interactionCoordinator?: GatewayInteractionCoordinatorPort;
  /** Application-selected abort-to-submit drain fence for live Gateway turns. */
  turnCompletionFence?: GatewayTurnCompletionFencePort;
  /** Application-selected `/compact` command projection provider. */
  manualCompactionCoordinator?: GatewayManualCompactionCoordinatorPort;
  /** Override a session's cwd via SessionConfigOverrides. */
  setSessionCwd?: (sessionKey: string, cwd: string) => void;
  /** Provider-neutral owner of live session permission grants. */
  permissionGrants?: GatewaySessionPermissionGrantPort;
  /** Provider-neutral owner of live session permission mode transitions. */
  permissionModes?: GatewaySessionPermissionModePort;
  /** Application-selected base mode used when a client omits its legacy mode field. */
  defaultPermissionMode?: PermissionMode;
  /** Provider-neutral Always-On control seam. */
  alwaysOnControl?: AlwaysOnControlPort;
  /**
   * Optional non-blocking post-turn callback. Used by createLocalGateway to
   * coalesce project-level memory maintenance after a turn has fully ended.
   */
  afterTurnCompleted?: (input: {
    sessionKey: string;
    projectKey?: string;
    runId: string;
  }) => void;
  telemetry?: TelemetryClient;
};

export class InProcessGateway implements Gateway {
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private readonly attachmentTurnComposer: GatewayAttachmentTurnComposerPort;
  private readonly agentEventProjector: GatewayAgentEventProjectorPort;
  private readonly agentEventTelemetryObserver: GatewayAgentEventTelemetryObserverPort;
  private readonly turnEventCoordinator: GatewayTurnEventCoordinatorPort;
  private readonly turnTelemetryContextResolver: GatewayTurnTelemetryContextResolverPort;
  private readonly turnReplacementCoordinator: GatewayTurnReplacementCoordinatorPort;
  private readonly interactionCoordinator: GatewayInteractionCoordinatorPort;
  private readonly permissionModes: GatewaySessionPermissionModePort;
  private readonly turnCompletionFence: GatewayTurnCompletionFencePort;
  private readonly manualCompactionCoordinator: GatewayManualCompactionCoordinatorPort;
  constructor(
    private readonly router: SessionRouter,
    private readonly options: InProcessGatewayOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.attachmentTurnComposer = options.attachmentTurnComposer ?? new GatewayAttachmentTurnComposer({
      ...(options.attachmentResolver ? { attachmentResolver: options.attachmentResolver } : {}),
    });
    this.agentEventProjector = options.agentEventProjector ?? new GatewayAgentEventProjector({
      toolResultArtifacts: options.toolResultArtifacts ?? new GatewayToolResultArtifactStore({
        ...(options.toolResultsDir ? { rootDir: options.toolResultsDir } : {}),
      }),
    });
    this.agentEventTelemetryObserver = options.agentEventTelemetryObserver
      ?? new GatewayAgentEventTelemetryObserver({ telemetry: options.telemetry });
    this.turnEventCoordinator = options.turnEventCoordinator
      ?? new GatewayTurnEventCoordinator({ replayStore: options.turnReplayStore });
    this.turnTelemetryContextResolver = options.turnTelemetryContextResolver
      ?? new GatewayTurnTelemetryContextResolver();
    this.turnReplacementCoordinator = options.turnReplacementCoordinator
      ?? new GatewayTurnReplacementCoordinator({
        storage: {
          replaceLastTurn: options.replaceLastTurn,
          finalizeLastTurnReplacement: options.finalizeLastTurnReplacement,
        },
        session: {
          activeTurnRunId: (sessionKey) => this.router.activeTurnRunId(sessionKey),
          hasActiveTurn: (sessionKey) => this.router.hasActiveTurn(sessionKey),
          abortExpectedTurn: (sessionKey, runId) => this.abortTurn({
            sessionKey,
            runId,
            reason: "message_replaced",
          }),
          closeSession: (sessionKey) => this.router.close(sessionKey),
        },
        timeoutMs: options.replacementTransactionTimeoutMs ?? DEFAULT_REPLACEMENT_TRANSACTION_TIMEOUT_MS,
      });
    this.interactionCoordinator = options.interactionCoordinator
      ?? new GatewayInteractionCoordinator({
        permissionGrants: options.permissionGrants,
        onElicitationDelivered: (sessionKey, requestId) => {
          options.dispatchHookForSession?.(sessionKey, "ElicitationResult", { requestId, delivered: true });
        },
    });
    this.permissionModes = options.permissionModes ?? new GatewaySessionPermissionModeRegistry();
    this.turnCompletionFence = options.turnCompletionFence ?? new GatewayTurnCompletionFence();
    this.manualCompactionCoordinator = options.manualCompactionCoordinator
      ?? new GatewayManualCompactionCoordinator({ router: this.router });
  }

  /**
   * B1 — exposed so per-session bridge channels can find the bus / emit
   * sink without going through `respondElicitation`. Caller MUST already
   * hold a sessionKey.
   */
  getElicitationBus(): GatewayElicitationBus {
    return this.interactionCoordinator.getElicitationBus();
  }

  /**
   * Web Phase 2 — exposed so per-session bridge channels (or tests) can
   * register pending permission decisions and emit `permission_request`
   * events.
   */
  getPermissionBus(): GatewayPermissionBus {
    return this.interactionCoordinator.getPermissionBus();
  }

  getInteractionReconnectPort(): InteractionReconnectPort {
    return this.interactionCoordinator.getReconnectPort();
  }

  getInteractionBinding(sessionKey: string): InteractionConnectionBinding | undefined {
    return this.interactionCoordinator.getBinding(sessionKey);
  }

  reconnectInteraction(input: import("../protocol/types.js").GatewayReconnectInteractionInput): import("../protocol/types.js").GatewayReconnectInteractionResult {
    return this.interactionCoordinator.reconnect(input);
  }

  disconnectInteraction(input: import("../protocol/types.js").GatewayDisconnectInteractionInput): import("../protocol/types.js").GatewayDisconnectInteractionResult {
    return this.interactionCoordinator.disconnect(input);
  }

  /**
   * Push a synthesized {@link GatewayEvent} into the active `submitTurn`
   * stream for the given session. Returns true when a sink existed and
   * the event was queued, false otherwise (e.g. no turn currently in
   * progress for that session).
   *
   * Used by per-session bridge hooks (notably the interactive
   * permission hook) that need to surface UI prompts mid-turn without
   * waiting for the agent's own event loop to emit them.
   */
  emitForSession(sessionKey: string, event: GatewayEvent): boolean {
    return this.turnEventCoordinator.emit(sessionKey, event);
  }

  broadcastRetryProgress(detail: {
    sessionId: string;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    reason: string;
    provider: string;
    model: string;
  }): void {
    const event: GatewayEvent = {
      type: "agent_status",
      event: "retry_progress",
      detail: {
        attempt: detail.attempt,
        maxAttempts: detail.maxAttempts,
        delayMs: detail.delayMs,
        reason: detail.reason,
        provider: detail.provider,
        model: detail.model,
      },
    };
    this.emitForSession(detail.sessionId, event);
  }

  async *submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
    if (input.interactionBinding) {
      const reconnect = this.interactionCoordinator.reconnectForTurn(
        input.sessionKey,
        input.interactionBinding,
      );
      if (reconnect.outcome === "stale_binding") {
        yield {
          type: "error",
          code: "interaction_reconnect_required",
          message: "This session has reconnectable interaction requests. Reconnect with the previous binding before submitting a new turn.",
          recoverable: true,
        };
        return;
      }
    }
    const invalidPermission = validateGatewayPermissionModes(input);
    if (invalidPermission) {
      yield {
        type: "error",
        code: "INVALID_PERMISSION_MODE",
        message: invalidPermission,
        recoverable: true,
      };
      return;
    }
    const compactCommand = parseCompactCommand(input.message);
    if (compactCommand.isCompactCommand) {
      if (!compactCommand.valid) {
        yield { type: "assistant_text_delta", text: COMPACT_COMMAND_USAGE };
        yield { type: "turn_completed", usage: {}, finishReason: "completed" };
        return;
      }
      const runId = input.runId ?? this.uuid();
      yield* this.manualCompactionCoordinator.execute({
        sessionKey: input.sessionKey,
        runId,
        timeoutMs: input.timeoutMs,
      });
      return;
    }
    const plannedInput = normalizePlanCommandInput(input);
    if (!plannedInput) {
      yield {
        type: "assistant_text_delta",
        text: PLAN_COMMAND_USAGE,
      };
      yield {
        type: "turn_completed",
        usage: {},
        finishReason: "completed",
      };
      return;
    }
    input = plannedInput;

    const runId = input.runId ?? this.uuid();
    const replacementClaim = this.turnReplacementCoordinator.claimForSubmit(input.sessionKey, runId);
    if (replacementClaim === "conflict") {
      const message = "This session is waiting for its edited replacement turn to be accepted.";
      yield {
        type: "error",
        runId,
        code: "replace_turn_pending",
        message,
        recoverable: true,
        userHint: "Wait for the edited message transaction to finish, then try again.",
      };
      return;
    }

    if (this.turnReplacementCoordinator.hasTranscriptWriteReservation(input.sessionKey)) {
      this.turnReplacementCoordinator.releaseSubmitClaim(input.sessionKey, runId);
      yield {
        type: "error",
        runId,
        code: "replace_turn_pending",
        message: "This session transcript is currently being updated.",
        recoverable: true,
        userHint: "Wait for the session update to finish, then try again.",
      };
      return;
    }
    if (!this.router.beginTurn(input.sessionKey, runId)) {
      this.turnReplacementCoordinator.releaseSubmitClaim(input.sessionKey, runId);
      const message = `Session ${input.sessionKey} already has an active turn.`;
      const userHint = "Wait for the current turn to finish or stop it before sending another message.";
      yield {
        type: "agent_status",
        event: "session_busy",
        detail: createVisibleErrorStatusDetail({
          message,
          code: "session_busy",
          userHint,
          scope: "session",
          source: "gateway",
        }),
      };
      yield {
        type: "error",
        code: "session_busy",
        message,
        recoverable: true,
        userHint,
      };
      return;
    }

    const turnCompletion = this.turnCompletionFence.begin(input.sessionKey);

    const queue = new AsyncQueue<GatewayEvent>();
    this.turnEventCoordinator.start(input.sessionKey, runId, (event) => queue.enqueue(event));
    const emitGatewayFailureStatus = (status: GatewayRecordAgentStatusMessageInput["status"]): Promise<void> => {
      const recorded = this.recordGatewayStatusMessage({
        sessionKey: input.sessionKey,
        turnId: runId,
        projectKey: input.projectKey,
        status,
      });
      const statusEvent: GatewayEvent = {
        type: "agent_status",
        runId,
        event: status.event,
        detail: status.detail,
      };
      this.turnEventCoordinator.record(input.sessionKey, statusEvent);
      queue.enqueue(statusEvent);
      return recorded;
    };

    if (input.workspaceCwd && this.options.setSessionCwd) {
      this.options.setSessionCwd(input.sessionKey, input.workspaceCwd);
    }

    const telemetryContext = this.turnTelemetryContextResolver.resolve(input);
    let timeoutHandle: NodeJS.Timeout | undefined;
    let timedOut = false;
    let uploadedAttachmentLease: ResolvedUploadedAttachments | undefined;

    // Background pump: agent events → queue.
    const pump = (async () => {
      try {
        // Refresh only after beginTurn has reserved the session. Replacement
        // submissions claim their transaction before this await, so an
        // expiration callback cannot roll the transcript back underneath a
        // submission that is already starting.
        if (this.options.refreshConfigBeforeTurn) {
          try {
            await this.options.refreshConfigBeforeTurn();
          } catch {
            // Keep streaming on the previous snapshot rather than failing a
            // turn over a transient yaml read error.
          }
        }
        const session = await this.router.getOrCreate({
          sessionKey: input.sessionKey,
          projectKey: input.projectKey,
          channelKey: input.channelKey,
        });
        const operationDeadline = operationDeadlineForTimeout(input.timeoutMs, this.now);
        if (input.timeoutMs !== undefined && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            const message = `Turn exceeded the ${input.timeoutMs}ms timeout.`;
            void emitGatewayFailureStatus(createGatewayFailureStatus({
              event: "turn_timeout",
              code: "turn_timeout",
              message,
              userHint: "The turn exceeded its wall-clock limit. Retry with a smaller task or increase the timeout.",
              detail: { timeoutMs: input.timeoutMs },
            }));
            const gatewayEvent: GatewayEvent = {
              type: "error",
              runId,
              code: "turn_timeout",
              message,
              recoverable: false,
              userHint: "The turn exceeded its wall-clock limit. Retry with a smaller task or increase the timeout.",
            };
            this.turnEventCoordinator.record(input.sessionKey, gatewayEvent);
            queue.enqueue(gatewayEvent);
            this.interactionCoordinator.rejectPendingTurn(input.sessionKey, "turn_timeout");
            queue.close();
            try {
              session.abort(`timeout:${runId}`);
            } catch {
              // The queue is already closed, so a faulty abort implementation
              // cannot defeat the hard turn timeout.
            }
          }, input.timeoutMs);
        }
        const permissionSettings = readPermissionSettings();
        const inputMode = normalizeGatewayModeForLegacyInput((input as { mode?: unknown }).mode);
        const runMode = normalizeGatewayRunMode((input as { runMode?: unknown }).runMode)
          ?? (inputMode === "plan" ? "plan" : "agent");
        const livePermissionMode = this.permissionModes.get(input.sessionKey);
        const permissionMode = inputMode
          ?? livePermissionMode
          ?? this.options.defaultPermissionMode
          ?? (permissionSettings.skipPermissions ? "bypassPermissions" : undefined);
        const basePermissionMode = normalizeGatewayModeForLegacyInput(
          (input as { basePermissionMode?: unknown }).basePermissionMode,
        ) ?? this.options.defaultPermissionMode;
        const allowPlanModeTools = input.allowPlanModeTools ?? inputMode === "plan";
        const persistedRules = permissionSettingsToRuleSet(permissionSettings);
        const sessionAllowRules = this.interactionCoordinator.sessionAllowRules(input.sessionKey);
        this.options.telemetry?.trackFeatureLoopStage({
          module: "session",
          ownerModule: telemetryContext.ownerModule,
          executionKind: telemetryContext.executionKind,
          phase: telemetryContext.phase,
          loopStage: "loop_start",
          outcome: "success",
          sessionId: input.sessionKey,
          metadata: {
            runId,
            channelKey: input.channelKey,
            permissionMode: permissionMode ?? "default",
          },
        });
        // Promote a text-only turn to blocks when the host channel attached
        // files/images. UI uploads come through this path; resolving them here
        // keeps attachment semantics in the gateway for every client.
        uploadedAttachmentLease = input.uploadedAttachments?.length
          ? await this.resolveUploadedAttachments(input)
          : undefined;
        const attachments = [...(input.attachments ?? []), ...(uploadedAttachmentLease?.attachments ?? [])];
        const { agentInput, allowedReadFiles } = await this.prepareAttachmentTurn(
          input.message,
          attachments,
          input.projectKey,
        );
        const syntheticMessages: CanonicalMessage[] = (input.syntheticMessages ?? []).map((s) => ({
          role: "user" as const,
          content: [{ type: "text" as const, text: s.text }],
          metadata: { synthetic: true, purpose: s.purpose ?? "channel_hint" },
        }));
        const modelSelection = this.options.resolveTurnModelSelection
          ? await this.options.resolveTurnModelSelection(input)
          : input.modelOverride
            ? { selection: input.modelOverride, source: "turn" as const }
            : { source: "default" as const };
        let lastEmittedModel: string | undefined;
        if (modelSelection.selection) {
          const event: GatewayEvent = {
            type: "model_selection_changed",
            provider: modelSelection.selection.provider,
            model: modelSelection.selection.model,
            source: modelSelection.source,
            reasoning: modelSelection.selection.reasoning,
            temperature: modelSelection.selection.temperature,
            speed: modelSelection.selection.speed,
            runId,
          };
          this.turnEventCoordinator.record(input.sessionKey, event);
          queue.enqueue(event);
          lastEmittedModel = `${modelSelection.selection.provider}\0${modelSelection.selection.model}`;
        }
        // A wall-clock timeout can fire while the Gateway is still resolving
        // attachments, config, or model selection. Do not admit a new
        // AgentSession turn after that timeout: submit() creates a fresh
        // abort controller and would otherwise revive a closed operation.
        if (timedOut) return;
        for await (const event of session.submit(
          agentInput,
          {
            turnId: runId,
            execution: {
              runId,
              operationId: runId,
              ...(operationDeadline ? { operationDeadline } : {}),
            },
            maxTurns: input.maxTurns,
            runMode,
            permissionMode,
            basePermissionMode,
            allowPlanModeTools,
            canPrompt: input.canPrompt,
            allowedReadFiles,
            permissionRules: {
              ...persistedRules,
              allow: [...sessionAllowRules, ...persistedRules.allow],
            },
            ...(syntheticMessages.length > 0 ? { syntheticMessages } : {}),
            ...(modelSelection.selection ? {
              modelOverride: {
                provider: modelSelection.selection.provider,
                model: modelSelection.selection.model,
                temperature: modelSelection.selection.temperature,
                speed: modelSelection.selection.speed,
                ...(modelSelection.selection.reasoning !== undefined ? {
                  thinking: {
                    enabled: modelSelection.selection.reasoning > 0,
                    mode: reasoningValueToMode(modelSelection.selection.reasoning),
                  },
                } : {}),
              },
            } : {}),
          },
        )) {
          if (!this.turnCompletionFence.isCurrent(input.sessionKey, turnCompletion)) {
            break;
          }
          this.agentEventTelemetryObserver.observe(event, {
            sessionId: input.sessionKey,
            runId,
            channelKey: input.channelKey,
            permissionMode: permissionMode ?? "default",
            ownerModule: telemetryContext.ownerModule,
            executionKind: telemetryContext.executionKind,
            phase: telemetryContext.phase,
          });
          if (event.type === "mode_change_requested" && isPermissionMode(event.mode)) {
            this.permissionModes.set(input.sessionKey, event.mode);
          }
          if (event.type === "input_accepted") {
            await this.turnReplacementCoordinator.commitAcceptedInput(input.sessionKey, runId);
          }
          if (event.type === "model_event" && event.event.type === "request_started"
            && lastEmittedModel !== `${event.event.provider}\0${event.event.model}`) {
            const selectionEvent: GatewayEvent = {
              type: "model_selection_changed",
              provider: event.event.provider,
              model: event.event.model,
              source: modelSelection.source,
              runId,
            };
            this.turnEventCoordinator.record(input.sessionKey, selectionEvent);
            queue.enqueue(selectionEvent);
            lastEmittedModel = `${event.event.provider}\0${event.event.model}`;
          }
          for (const gatewayEvent of this.agentEventProjector.project({ event, runId })) {
            if (gatewayEvent.type === "context_budget") {
              this.recordGatewayStatusMessage({
                sessionKey: input.sessionKey,
                turnId: runId,
                projectKey: input.projectKey,
                status: {
                  event: "context_budget",
                  kind: "status",
                  text: "context_budget",
                  detail: { ...gatewayEvent },
                },
              }).catch(() => {});
            }
            this.turnEventCoordinator.record(input.sessionKey, gatewayEvent);
            queue.enqueue(gatewayEvent);
          }
        }
      } catch (error) {
        this.options.telemetry?.trackError(error, {
          module: "session",
          ownerModule: telemetryContext.ownerModule,
          executionKind: telemetryContext.executionKind,
          phase: telemetryContext.phase,
          loopStage: "loop_end",
          errorCategory: "loop_error",
          sessionId: input.sessionKey,
          metadata: {
            runId,
            channelKey: input.channelKey,
          },
        });
        if (this.turnCompletionFence.isCurrent(input.sessionKey, turnCompletion)) {
          const message = error instanceof Error ? error.message : String(error);
          await emitGatewayFailureStatus(createGatewayFailureStatus({
            event: "gateway_submit_failed",
            code: "gateway_submit_failed",
            message,
            userHint: "PilotDeck failed before the agent turn could finish. Retry this message; if it repeats, check the gateway logs.",
          }));
          const gatewayEvent: GatewayEvent = {
            type: "error",
            runId,
            code: "gateway_submit_failed",
            message,
            recoverable: false,
            userHint: "PilotDeck failed before the agent turn could finish. Retry this message; if it repeats, check the gateway logs.",
          };
          this.turnEventCoordinator.record(input.sessionKey, gatewayEvent);
          queue.enqueue(gatewayEvent);
        }
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        if (uploadedAttachmentLease) {
          try {
            await uploadedAttachmentLease.release();
          } catch (error) {
            console.warn("[pilotdeck] failed to release uploaded attachment lease:", error);
          }
        }
        queue.close();
      }
    })();

    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      // Clean up the emit-sink and any orphaned elicitation / permission
      // entries before returning so a subsequent turn doesn't see stale
      // state.
      this.turnEventCoordinator.retainTerminal(input.sessionKey, runId);
      this.interactionCoordinator.rejectPendingTurn(input.sessionKey, "turn_ended");
      this.router.endTurn(input.sessionKey, runId);
      if (timedOut) {
        // The timed-out AgentSession is never safe to reuse. Do not await a
        // misbehaving tool here: the hard timeout must release the Cron run.
        void this.router.close(input.sessionKey).catch(() => undefined);
        void pump.catch(() => undefined);
      } else {
        // Defensive — make sure the pump promise is settled before we resolve.
        await pump.catch(() => undefined);
      }
      // Signal any in-flight `abortTurn` awaiters after Router cleanup.
      // The fence only owns this short-lived drain promise; it does not
      // decide whether another turn may be admitted.
      this.turnCompletionFence.complete(input.sessionKey, turnCompletion);
      this.turnReplacementCoordinator.releaseSubmitClaim(input.sessionKey, runId);
      this.options.afterTurnCompleted?.({
        sessionKey: input.sessionKey,
        projectKey: input.projectKey,
        runId,
      });
    }
  }

  async steerTurn(input: GatewaySteerTurnInput): Promise<GatewaySteerTurnResult> {
    const activeRunId = this.router.activeTurnRunId(input.sessionKey);
    if (!activeRunId) return { accepted: false, reason: "no_active_turn" };
    if (activeRunId !== input.runId) return { accepted: false, reason: "turn_mismatch" };

    const attachments = input.attachments ?? [];
    const { agentInput, allowedReadFiles } = await this.prepareAttachmentTurn(
      input.message,
      attachments,
      input.projectKey,
    );
    const message: CanonicalMessage = {
      role: "user",
      content: agentInput.type === "text"
        ? [{ type: "text", text: agentInput.text }]
        : agentInput.content,
      metadata: { purpose: "mid_turn_steer", queueItemId: input.itemId },
    };
    return this.router.steer(input.sessionKey, {
      turnId: input.runId,
      itemId: input.itemId,
      message,
      allowedReadFiles,
    });
  }

  async cancelSteer(input: GatewayCancelSteerInput): Promise<GatewayCancelSteerResult> {
    const activeRunId = this.router.activeTurnRunId(input.sessionKey);
    if (!activeRunId) return { cancelled: false, reason: "no_active_turn" };
    if (activeRunId !== input.runId) return { cancelled: false, reason: "turn_mismatch" };
    return this.router.cancelSteer(input.sessionKey, {
      turnId: input.runId,
      itemId: input.itemId,
    });
  }

  async abortTurn(input: { sessionKey: string; runId?: string; reason?: string }): Promise<void> {
    const reason = input.reason ?? (input.runId ? `aborted:${input.runId}` : "aborted");
    await this.router.abort(input.sessionKey, reason);
    // Wait for the in-flight `submitTurn` (if any) to fully unwind so
    // `inFlightTurns` has been cleared by the time the RPC response is
    // sent. Otherwise a fast "stop → re-send" from a client races the
    // gateway's own cleanup and the next submit is rejected with
    // `session_busy`.
    await this.turnCompletionFence.waitForCompletion(input.sessionKey);
  }

  async listSessions(input: ListSessionsInput): Promise<ListSessionsResult> {
    return this.router.list(input);
  }

  async resumeSession(input: { sessionKey: string }): Promise<{ sessionKey: string }> {
    return input;
  }

  async newSession(input: NewSessionInput): Promise<{ sessionKey: string }> {
    const suffix = this.uuid();
    const projectKey = input.projectKey ? `project=${input.projectKey}:` : "";
    return { sessionKey: `${input.channelKey}:${projectKey}s_${suffix}` };
  }

  async closeSession(input: { sessionKey: string; reason?: string }): Promise<void> {
    await this.router.close(input.sessionKey);
    this.interactionCoordinator.closeSession(input.sessionKey, input.reason ?? "session_closed");
    this.permissionModes.clear(input.sessionKey);
  }

  /**
   * Gateway ownership boundary. Session scopes own their individual channels;
   * this drains any remaining host round-trips and then releases the shared
   * reconnect provider when the process-level Gateway exits.
   */
  dispose(reason = "gateway_disposed"): void {
    this.turnReplacementCoordinator.dispose();
    this.turnEventCoordinator.dispose();
    this.interactionCoordinator.dispose(reason);
    this.permissionModes.dispose();
  }

  async recordAgentStatusMessage(input: GatewayRecordAgentStatusMessageInput): Promise<{ recorded: boolean }> {
    const recordLive = this.router.recordAgentStatusMessage;
    if (typeof recordLive === "function") {
      const live = await recordLive.call(this.router, input.sessionKey, input.turnId, input.status);
      if (live.owner === "live") {
        return { recorded: live.recorded };
      }
    }
    if (!this.options.recordAgentStatusMessage) return { recorded: false };
    return this.options.recordAgentStatusMessage(input);
  }

  private async recordGatewayStatusMessage(input: GatewayRecordAgentStatusMessageInput): Promise<void> {
    try {
      await this.recordAgentStatusMessage(input);
    } catch (error) {
      console.warn("[pilotdeck] failed to record gateway status message:", error);
    }
  }

  async describeServer(): Promise<GatewayServerInfo> {
    const capabilities = [
      ...(this.options.listProjects ? ["project_files_list" as const] : []),
      ...(this.options.commandsList ? ["commands_list" as const] : []),
      ...(this.options.modelCatalogList ? ["model_catalog_list" as const] : []),
      ...(this.options.sessionModelGet ? ["session_model_get" as const] : []),
      ...(this.options.sessionModelSet ? ["session_model_set" as const] : []),
      ...(this.options.sessionModelClear ? ["session_model_clear" as const] : []),
    ] as GatewayServerInfo["capabilities"];
    return {
      mode: "in_process",
      sessionCount: this.router.sessionCount(),
      ...this.options.serverInfo,
      capabilities,
    };
  }

  async projectFilesList(input: ProjectFilesListInput): Promise<ProjectFilesListResult> {
    if (!this.options.listProjects) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "project_files_list is unavailable.");
    const projects = await this.listProjects();
    const requested = resolve(input.projectKey);
    const registered = projects.projects.find((project) => resolve(project.projectKey) === requested);
    if (!registered) {
      throw new DialogGatewayError("PROJECT_NOT_FOUND", `Unknown projectKey: ${input.projectKey}`);
    }
    return listProjectFiles({ ...input, projectKey: registered.projectKey });
  }

  async commandsList(input: CommandsListInput): Promise<CommandsListResult> {
    if (!this.options.commandsList) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "commands_list is unavailable.");
    return this.options.commandsList(input);
  }

  async modelCatalogList(input: ModelCatalogListInput): Promise<ModelCatalogListResult> {
    if (!this.options.modelCatalogList) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "model_catalog_list is unavailable.");
    return this.options.modelCatalogList(input);
  }

  async sessionModelGet(input: SessionModelInput): Promise<SessionModelResult> {
    if (!this.options.sessionModelGet) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "session_model_get is unavailable.");
    return this.options.sessionModelGet(input);
  }

  async sessionModelSet(input: SessionModelSetInput): Promise<SessionModelResult> {
    if (!this.options.sessionModelSet) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "session_model_set is unavailable.");
    this.turnReplacementCoordinator.reserveTranscriptWrite(input.sessionKey, "change the session model");
    try {
      return await this.options.sessionModelSet(input);
    } finally {
      this.turnReplacementCoordinator.releaseTranscriptWrite(input.sessionKey);
    }
  }

  async sessionModelClear(input: SessionModelInput): Promise<void> {
    if (!this.options.sessionModelClear) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "session_model_clear is unavailable.");
    this.turnReplacementCoordinator.reserveTranscriptWrite(input.sessionKey, "clear the session model");
    try {
      await this.options.sessionModelClear(input);
    } finally {
      this.turnReplacementCoordinator.releaseTranscriptWrite(input.sessionKey);
    }
  }

  private async resolveUploadedAttachments(input: GatewaySubmitTurnInput): Promise<ResolvedUploadedAttachments> {
    if (!input.projectKey) throw new DialogGatewayError("PROJECT_NOT_FOUND", "projectKey is required for uploaded attachments.");
    if (!this.options.resolveUploadedAttachments) throw new DialogGatewayError("CAPABILITY_UNAVAILABLE", "Uploaded attachments are unavailable.");
    return this.options.resolveUploadedAttachments({ projectKey: input.projectKey, uploads: input.uploadedAttachments ?? [] });
  }

  private prepareAttachmentTurn(
    message: string,
    attachments: ChannelAttachment[] | undefined,
    projectRoot?: string,
  ) {
    return this.attachmentTurnComposer.prepare({
      message,
      attachments,
      projectRoot,
      funasrInstallCommand: this.options.funasrInstallCommand ?? getPilotDeckInstallCommand(),
    });
  }

  async getActiveTurnSnapshot(input: GatewayActiveTurnSnapshotInput): Promise<GatewayActiveTurnSnapshot> {
    return this.turnEventCoordinator.snapshot(input);
  }

  async cronCreate(input: CronCreateInput): Promise<CronCreateResult> {
    return this.requireCron().createTask(input);
  }

  async cronList(input: CronListInput): Promise<CronListResult> {
    return this.requireCron().listTasks(input);
  }

  async cronUpdate(input: CronUpdateInput): Promise<CronUpdateResult> {
    return this.requireCron().updateTask(input);
  }

  async cronDelete(input: CronDeleteInput): Promise<CronDeleteResult> {
    return this.requireCron().deleteTask(input);
  }

  async cronStop(input: CronStopInput): Promise<CronStopResult> {
    return this.requireCron().stopTask(input);
  }

  async cronRunNow(input: CronRunNowInput): Promise<CronRunNowResult> {
    return this.requireCron().runTaskNow(input);
  }

  async respondElicitation(input: GatewayElicitationResponseInput): Promise<{ delivered: boolean }> {
    return this.interactionCoordinator.respondElicitation(input);
  }

  async permissionDecide(input: GatewayPermissionDecisionInput): Promise<{ delivered: boolean }> {
    return this.interactionCoordinator.decidePermission(input);
  }

  async grantSessionPermission(input: GatewaySessionPermissionGrantInput): Promise<{ granted: boolean; entry?: string }> {
    return this.interactionCoordinator.grantSessionPermission(input);
  }

  async readSessionMessages(input: WebReadSessionMessagesInput): Promise<WebReadSessionMessagesResult> {
    if (!this.options.readSessionMessages) {
      throw new Error(
        "read_session_messages is not configured. Wire `readSessionMessages` via createLocalGateway.",
      );
    }
    return this.options.readSessionMessages(input);
  }

  async readSubagentMessages(input: WebReadSubagentMessagesInput): Promise<WebReadSubagentMessagesResult> {
    if (!this.options.readSubagentMessages) {
      throw new Error(
        "read_subagent_messages is not configured. Wire `readSubagentMessages` via createLocalGateway.",
      );
    }
    return this.options.readSubagentMessages(input);
  }

  async forkSession(input: WebForkSessionInput): Promise<WebForkSessionResult> {
    if (!this.options.forkSession) {
      throw new Error(
        "fork_session is not configured. Wire `forkSession` via createLocalGateway.",
      );
    }
    return this.options.forkSession(input);
  }

  async replaceLastTurn(input: WebReplaceLastTurnInput): Promise<WebReplaceLastTurnResult> {
    return this.turnReplacementCoordinator.replaceLastTurn(input);
  }

  async finalizeLastTurnReplacement(
    input: WebFinalizeLastTurnReplacementInput,
  ): Promise<WebFinalizeLastTurnReplacementResult> {
    return this.turnReplacementCoordinator.finalizeLastTurnReplacement(input);
  }

  async listProjects(): Promise<WebListProjectsResult> {
    if (!this.options.listProjects) {
      throw new Error("list_projects is not configured.");
    }
    return this.options.listProjects();
  }

  async describeProject(input: WebDescribeProjectInput): Promise<WebProjectSummary> {
    if (!this.options.describeProject) {
      throw new Error("describe_project is not configured.");
    }
    return this.options.describeProject(input);
  }

  async reloadConfig(): Promise<ReloadConfigResult> {
    if (!this.options.reloadConfig) {
      return { reloaded: false, reason: "unsupported" };
    }
    return this.options.reloadConfig();
  }

  async prepareWeixinLogin(): Promise<PrepareWeixinLoginResult> {
    if (!this.options.prepareWeixinLogin) {
      return {
        requested: false,
        requestedAt: new Date().toISOString(),
        reason: "unsupported",
      };
    }
    return this.options.prepareWeixinLogin();
  }

  async reloadExtensions(input?: import("../protocol/types.js").ReloadExtensionsInput): Promise<import("../protocol/types.js").ReloadExtensionsResult> {
    if (!this.options.reloadExtensions) {
      return { reloaded: false, reason: "unsupported" };
    }
    return this.options.reloadExtensions(input);
  }

  setCronController(cron: GatewayCronController | undefined): void {
    (this.options as { cron?: GatewayCronController }).cron = cron;
  }

  setAlwaysOnControl(control: AlwaysOnControlPort | undefined): void {
    (this.options as { alwaysOnControl?: AlwaysOnControlPort }).alwaysOnControl = control;
  }

  setPrepareWeixinLogin(handler: InProcessGatewayOptions["prepareWeixinLogin"]): void {
    (this.options as { prepareWeixinLogin?: InProcessGatewayOptions["prepareWeixinLogin"] }).prepareWeixinLogin = handler;
  }

  // -------------------------------------------------------------------
  // Skill management — see `SkillManager` for the actual disk ops. The
  // gateway methods just guard "skill manager configured" and translate
  // domain errors into structured failures the WS dispatcher and host
  // bridges can render. `SkillValidationError` is preserved as a special
  // case so the UI can surface the `validation` payload to the user.
  // -------------------------------------------------------------------

  async skillsList(input: SkillsListInput): Promise<SkillsListResult> {
    return this.requireSkills().list(input);
  }

  async skillRead(input: SkillAddressInput): Promise<SkillReadResult> {
    return this.requireSkills().read(input);
  }

  async skillWrite(input: SkillWriteInput): Promise<SkillWriteResult> {
    return this.requireSkills().write(input);
  }

  async skillCreate(input: SkillCreateInput): Promise<SkillCreateResult> {
    return this.requireSkills().create(input);
  }

  async skillDelete(input: SkillDeleteInput): Promise<SkillDeleteResult> {
    return this.requireSkills().delete(input);
  }

  async skillImport(input: SkillImportInput): Promise<SkillImportResult> {
    return this.requireSkills().import(input);
  }

  async skillValidate(input: SkillValidateInput): Promise<SkillValidationResult> {
    return this.requireSkills().validate(input);
  }

  async skillScan(input: SkillScanInput): Promise<SkillScanResult> {
    return this.requireSkills().scan(input);
  }

  private requireSkills(): SkillManager {
    if (!this.options.skillManager) {
      throw new SkillManagerError(
        "not_configured",
        "Skill manager is not configured on this gateway.",
      );
    }
    return this.options.skillManager;
  }

  async alwaysOnApply(input: AlwaysOnApplyInput): Promise<AlwaysOnApplyResult> {
    if (!this.options.alwaysOnControl) {
      return { sessionKey: "", error: { code: "not_configured", message: "Always-On apply is not configured on this gateway." } };
    }
    return this.options.alwaysOnControl.applyCycle(input);
  }

  async alwaysOnAbort(input: AlwaysOnAbortInput): Promise<AlwaysOnAbortResult> {
    if (!this.options.alwaysOnControl) {
      return {
        aborted: false,
        sessionKey: input.sessionKey,
        error: { code: "not_configured", message: "Always-On abort is not configured on this gateway." },
      };
    }
    return this.options.alwaysOnControl.abortRun(input);
  }

  async alwaysOnRerunPlan(input: AlwaysOnRerunPlanInput): Promise<AlwaysOnRerunPlanResult> {
    if (!this.options.alwaysOnControl) {
      return { runId: "", error: { code: "not_configured", message: "Always-On rerun is not configured on this gateway." } };
    }
    return this.options.alwaysOnControl.rerunPlan(input);
  }

  private requireCron(): GatewayCronController {
    if (!this.options.cron) {
      throw new Error("Cron runtime is not configured.");
    }
    return this.options.cron;
  }

}

function createGatewayFailureStatus(args: {
  event: string;
  code: string;
  message: string;
  userHint: string;
  detail?: Record<string, unknown>;
}): GatewayRecordAgentStatusMessageInput["status"] {
  return {
    event: args.event,
    kind: "error",
    text: args.message,
    detail: createVisibleErrorStatusDetail({
      message: args.message,
      code: args.code,
      userHint: args.userHint,
      scope: "turn",
      source: "gateway",
      detail: args.detail,
    }),
  };
}

export function normalizeGatewayModeForLegacyInput(value: unknown): GatewaySubmitTurnInput["mode"] | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (isPermissionMode(value)) {
    return value;
  }
  return undefined;
}

function validateGatewayPermissionModes(input: GatewaySubmitTurnInput): string | undefined {
  const mode = (input as { mode?: unknown }).mode;
  if (mode !== undefined && mode !== null && mode !== "" && !isPermissionMode(mode)) {
    return `Invalid mode: ${String(mode)}.`;
  }
  const baseMode = (input as { basePermissionMode?: unknown }).basePermissionMode;
  if (baseMode !== undefined && baseMode !== null && baseMode !== ""
    && baseMode !== "default" && baseMode !== "bypassPermissions") {
    return `Invalid basePermissionMode: ${String(baseMode)}.`;
  }
  return undefined;
}

function reasoningValueToMode(value: number): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  const modes = new Map<number, "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max">([
    [0, "off"], [0.2, "minimal"], [0.4, "low"], [0.6, "medium"], [0.8, "high"], [0.9, "xhigh"], [1, "max"],
  ]);
  const mode = modes.get(value);
  if (!mode) throw new DialogGatewayError("UNSUPPORTED_MODEL_PARAMETER", `Unsupported reasoning value: ${value}`);
  return mode;
}

export function normalizeGatewayRunMode(value: unknown): GatewaySubmitTurnInput["runMode"] | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return parseAgentRunMode(value) ?? "agent";
}

function normalizePlanCommandInput(input: GatewaySubmitTurnInput): GatewaySubmitTurnInput | undefined {
  const parsed = parsePlanCommand(input.message);
  if (!parsed.isPlanCommand) {
    return input;
  }
  if (!parsed.message) {
    return undefined;
  }
  return {
    ...input,
    message: parsed.message,
    runMode: "plan",
    mode: "plan",
    basePermissionMode: input.basePermissionMode ?? input.mode ?? "default",
    allowPlanModeTools: true,
  };
}

function parsePlanCommand(message: string): { isPlanCommand: boolean; message: string } {
  const trimmed = message.trim();
  const match = trimmed.match(/^\/plan(?:\s+([\s\S]*))?$/u);
  if (!match) {
    return { isPlanCommand: false, message };
  }
  return {
    isPlanCommand: true,
    message: (match[1] ?? "").trim(),
  };
}

function parseCompactCommand(message: string): { isCompactCommand: boolean; valid: boolean } {
  const trimmed = message.trim();
  if (!/^\/compact(?:\s|$)/u.test(trimmed)) return { isCompactCommand: false, valid: false };
  return { isCompactCommand: true, valid: /^\/compact$/u.test(trimmed) };
}

function operationDeadlineForTimeout(
  timeoutMs: number | undefined,
  now: () => Date,
): string | undefined {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return undefined;
  const startedAt = now().getTime();
  if (!Number.isFinite(startedAt)) return undefined;
  return new Date(startedAt + timeoutMs).toISOString();
}
