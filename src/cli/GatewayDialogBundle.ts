import {
  AttachmentResolver,
  type AttachmentPort,
} from "../context/index.js";
import {
  UploadStore,
} from "../gateway/dialog/UploadStore.js";
import type { UploadLifecyclePort } from "../gateway/dialog/UploadLifecyclePort.js";
import { GatewayAttachmentTurnComposer } from "../gateway/dialog/GatewayAttachmentTurnComposer.js";
import {
  createDialogProjectRegistry,
  type DialogProjectRegistry,
} from "../gateway/dialog/projectRegistry.js";
import type {
  WebDescribeProjectInput,
  WebListProjectsResult,
  WebProjectSummary,
} from "../gateway/protocol/types.js";
import type { SessionCatalogPort } from "../session/index.js";
import {
  describeWebProject,
  listWebProjects,
} from "../web/server/listProjects.js";
import { GatewayUploadedAttachmentBundle } from "./GatewayUploadedAttachmentBundle.js";

export type GatewayDialogBundleOptions = {
  pilotHome: string;
  sessionCatalog: SessionCatalogPort;
  attachmentPort?: AttachmentPort;
  /** Selected upload lifecycle provider. The native filesystem provider is the default. */
  uploadLifecycle?: UploadLifecyclePort;
};

/**
 * Application composition for dialog projects, browser uploads, and
 * model-visible attachments. Each provider remains the source of truth for
 * its own state: project metadata comes from the web catalog, UploadStore
 * owns artifact retention, AttachmentResolver owns model projection, and the
 * turn composer owns only the resulting Gateway input projection.
 */
export class GatewayDialogBundle {
  readonly projects: DialogProjectRegistry;
  readonly uploads: UploadLifecyclePort;
  readonly uploadedAttachments: GatewayUploadedAttachmentBundle;
  readonly attachmentResolver: AttachmentResolver;
  readonly attachmentTurnComposer: GatewayAttachmentTurnComposer;

  constructor(options: GatewayDialogBundleOptions) {
    const projectCatalog = {
      list: (): Promise<WebListProjectsResult> => listWebProjects({
        pilotHome: options.pilotHome,
        sessionCatalog: options.sessionCatalog,
      }),
      describe: (input: WebDescribeProjectInput): Promise<WebProjectSummary> => describeWebProject(
        input.projectKey,
        {
          pilotHome: options.pilotHome,
          sessionCatalog: options.sessionCatalog,
        },
      ),
    };
    this.projects = createDialogProjectRegistry({
      pilotHome: options.pilotHome,
      listProjects: async () => (await projectCatalog.list()).projects,
    });
    this.uploads = options.uploadLifecycle ?? new UploadStore({
      listProjects: this.projects.listProjectKeys,
      resolveProject: this.projects.resolveProjectKey,
    });
    this.uploadedAttachments = new GatewayUploadedAttachmentBundle({
      provider: this.uploads,
    });
    this.attachmentResolver = new AttachmentResolver({
      ...(options.attachmentPort ? { attachmentPort: options.attachmentPort } : {}),
    });
    this.attachmentTurnComposer = new GatewayAttachmentTurnComposer({
      attachmentResolver: this.attachmentResolver,
    });
    this.listProjects = projectCatalog.list;
    this.describeProject = projectCatalog.describe;
  }

  readonly listProjects: () => Promise<WebListProjectsResult>;
  readonly describeProject: (input: WebDescribeProjectInput) => Promise<WebProjectSummary>;
}
