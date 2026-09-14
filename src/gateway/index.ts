export { createGateway, type CreateGatewayOptions, type GatewayProjectStorageOptions } from "./Gateway.js";
export {
  createGatewaySessionCatalogConsumer,
  type CreateGatewaySessionCatalogConsumerOptions,
  type GatewaySessionCatalogStorage,
} from "./GatewaySessionCatalog.js";
export {
  SessionRouter,
  type GatewaySessionContext,
  type GatewaySessionFactory,
  type GatewaySessionSetup,
  type SessionEvictionSnapshot,
  type SessionRouterOptions,
} from "./SessionRouter.js";
export {
  isGatewayMemoryDiagnosticsEnabled,
  logGatewayMemoryDiagnostic,
  summarizeCanonicalMessages,
  type GatewayMemoryDiagnosticInput,
  type GatewayMemoryDiagnosticSession,
} from "./memoryDiagnostics.js";
export { InProcessGateway, mapAgentEvent, type InProcessGatewayOptions } from "./client/InProcessGateway.js";
export {
  GatewayAgentEventProjector,
  type GatewayAgentEventProjectorOptions,
} from "./client/GatewayAgentEventProjector.js";
export type {
  GatewayAgentEventProjectionInput,
  GatewayAgentEventProjectorPort,
} from "./client/GatewayAgentEventProjectorPort.js";
export {
  GatewayAgentEventTelemetryObserver,
  type GatewayAgentEventTelemetryObserverOptions,
} from "./client/GatewayAgentEventTelemetryObserver.js";
export type {
  GatewayAgentEventTelemetryContext,
  GatewayAgentEventTelemetryObserverPort,
} from "./client/GatewayAgentEventTelemetryObserverPort.js";
export {
  GatewayTurnReplayStore,
  type GatewayTurnReplayStoreOptions,
} from "./client/GatewayTurnReplayStore.js";
export type { GatewayTurnReplayStorePort } from "./client/GatewayTurnReplayStorePort.js";
export { GatewayTurnTelemetryContextResolver } from "./client/GatewayTurnTelemetryContextResolver.js";
export type {
  GatewayTurnTelemetryContext,
  GatewayTurnTelemetryContextInput,
  GatewayTurnTelemetryContextResolverPort,
} from "./client/GatewayTurnTelemetryContextResolverPort.js";
export {
  GatewayTurnReplacementCoordinator,
  type GatewayTurnReplacementCoordinatorOptions,
  type GatewayTurnReplacementSessionPort,
  type GatewayTurnReplacementStoragePort,
} from "./client/GatewayTurnReplacementCoordinator.js";
export type { GatewayTurnReplacementCoordinatorPort } from "./client/GatewayTurnReplacementCoordinatorPort.js";
export {
  GatewayInteractionCoordinator,
  type GatewayInteractionCoordinatorOptions,
} from "./client/GatewayInteractionCoordinator.js";
export type { GatewayInteractionCoordinatorPort } from "./client/GatewayInteractionCoordinatorPort.js";
export {
  GatewaySessionPermissionModeRegistry,
  type GatewaySessionPermissionModePort,
} from "./permission/GatewaySessionPermissionModeRegistry.js";
export { GatewayTurnCompletionFence } from "./client/GatewayTurnCompletionFence.js";
export type {
  GatewayTurnCompletionFencePort,
  GatewayTurnCompletionHandle,
} from "./client/GatewayTurnCompletionFencePort.js";
export {
  GatewayManualCompactionCoordinator,
  type GatewayManualCompactionCoordinatorOptions,
  type GatewayManualCompactionRouterPort,
} from "./client/GatewayManualCompactionCoordinator.js";
export type {
  GatewayManualCompactionCoordinatorPort,
  GatewayManualCompactionInput,
} from "./client/GatewayManualCompactionCoordinatorPort.js";
export {
  GatewayTurnEventCoordinator,
  type GatewayTurnEventCoordinatorOptions,
} from "./client/GatewayTurnEventCoordinator.js";
export type { GatewayTurnEventCoordinatorPort } from "./client/GatewayTurnEventCoordinatorPort.js";
export {
  GatewayToolResultArtifactStore,
  type GatewayToolResultArtifactStoreOptions,
} from "./client/GatewayToolResultArtifactStore.js";
export type {
  GatewayToolResultArtifactInput,
  GatewayToolResultArtifactStorePort,
} from "./client/GatewayToolResultArtifactStorePort.js";
export {
  GatewayAttachmentTurnComposer,
  type GatewayAttachmentTurnComposerOptions,
} from "./dialog/GatewayAttachmentTurnComposer.js";
export type {
  GatewayAttachmentTurnComposerInput,
  GatewayAttachmentTurnComposerPort,
  GatewayAttachmentTurnComposition,
} from "./dialog/GatewayAttachmentTurnComposerPort.js";
export { GatewayWsClient, GatewayRequestError, type GatewayWsClientOptions } from "./client/GatewayWsClient.js";
export { RemoteGateway, createRemoteGateway } from "./client/RemoteGateway.js";
export { connectRemoteGatewayIfAvailable, probeGatewayServer, type ProbeGatewayServerOptions } from "./client/probeServer.js";
export { startGatewayServer, type GatewayServer, type GatewayServerOptions } from "./server/GatewayServer.js";
export {
  ensureGatewayAuthToken,
  readGatewayAuthToken,
  resolveGatewayTokenPath,
  type GatewayAuthTokenOptions,
} from "./server/authToken.js";
export type {
  ChannelAttachment,
  GatewayOutboundAttachment,
  Gateway,
  GatewayActiveTurnSnapshot,
  GatewayActiveTurnSnapshotInput,
  GatewayChannelKey,
  GatewayCronController,
  GatewayElicitationResponseInput,
  GatewayError,
  GatewayEvent,
  GatewayReconnectInteractionInput,
  GatewayReconnectInteractionResult,
  GatewayDisconnectInteractionInput,
  GatewayDisconnectInteractionResult,
  GatewayMode,
  GatewayCapability,
  GatewayServerInfo,
  GatewaySessionInfo,
  GatewaySubmitTurnInput,
  GatewayCancelSteerInput,
  GatewayCancelSteerResult,
  GatewaySteerTurnInput,
  GatewaySteerTurnResult,
  MatchRange,
  ProjectFileEntry,
  ProjectFilesListInput,
  ProjectFilesListResult,
  CommandListItem,
  CommandsListInput,
  CommandsListResult,
  ModelCatalogItem,
  ModelCatalogListInput,
  ModelCatalogListResult,
  ExplicitModelSelection,
  SessionModelSelection,
  SessionModelInput,
  SessionModelSetInput,
  SessionModelResult,
  UploadedAttachmentRef,
  ListSessionsInput,
  ListSessionsResult,
  NewSessionInput,
  PrepareWeixinLoginResult,
  ReloadConfigResult,
  TurnUsage,
} from "./protocol/index.js";
export {
  GatewayElicitationBus,
  type GatewayElicitationReconnectOptions,
  type GatewayElicitationRegistration,
} from "./elicitation/GatewayElicitationBus.js";
export { GatewayElicitationChannel } from "./elicitation/GatewayElicitationChannel.js";
export {
  createGatewayHookExecutionProjection,
  toGatewayHookExecutionStatus,
  type GatewayHookExecutionProjectionOptions,
} from "./hooks/GatewayHookExecutionProjection.js";
export {
  createGatewayBackgroundTaskCompletionProjection,
  toGatewayBackgroundTaskCompletionStatus,
  type GatewayBackgroundTaskCompletionProjectionOptions,
} from "./tasks/GatewayBackgroundTaskCompletionProjection.js";
export {
  GatewaySessionLiveProjectionBundle,
  type GatewayBackgroundTaskCompletionEventSource,
  type GatewayHookExecutionEventSource,
  type GatewaySessionLiveProjectionBundleOptions,
} from "./GatewaySessionLiveProjectionBundle.js";
export {
  GatewayPermissionBus,
  type GatewayPermissionDecision,
  type GatewayPermissionPending,
  type GatewayPermissionRegistration,
} from "./permission/GatewayPermissionBus.js";
export {
  GatewaySessionPermissionRuleSetRegistry,
  type GatewaySessionPermissionGrantPort,
  type GatewaySessionPermissionRuleSetLease,
} from "./permission/GatewaySessionPermissionRuleSetRegistry.js";
export { AsyncQueue } from "./util/AsyncQueue.js";
export type {
  UploadArtifactLease,
  UploadArtifactLeaseProvider,
  UploadedAttachment,
} from "./dialog/UploadArtifactLeasePort.js";
export type {
  UploadLifecyclePort,
  UploadManifestEntry,
  UploadRecord,
  UploadStatus,
} from "./dialog/UploadLifecyclePort.js";
export type {
  ResolvedUploadedAttachments,
  UploadedAttachmentResolverPort,
} from "./dialog/UploadedAttachmentResolverPort.js";
export type {
  GatewayWsClientName,
  WsEventFrame,
  WsGatewayFrame,
  WsGatewayMethod,
  WsHelloFrame,
  WsHelloOk,
  WsRequestFrame,
  WsNotificationFrame,
  WsResponseFrame,
} from "./protocol/index.js";
export { PILOTDECK_GATEWAY_PROTOCOL_VERSION } from "./protocol/index.js";
