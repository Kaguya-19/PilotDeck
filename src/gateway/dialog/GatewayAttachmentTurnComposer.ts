import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentInput } from "../../agent/index.js";
import type { CanonicalContentBlock } from "../../model/index.js";
import {
  AttachmentResolver,
  type AttachmentRequest,
} from "../../context/attachments/AttachmentResolver.js";
import type { ChannelAttachment } from "../protocol/types.js";
import type {
  GatewayAttachmentTurnComposerInput,
  GatewayAttachmentTurnComposerPort,
  GatewayAttachmentTurnComposition,
} from "./GatewayAttachmentTurnComposerPort.js";

export type GatewayAttachmentTurnComposerOptions = {
  attachmentResolver?: AttachmentResolver;
};

const ATTACHMENT_PATH_NOTE_MARKER = "[Registered attachment files in this session:]";
const READ_FILE_BINARY_ATTACHMENT_EXTENSIONS = new Set([
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".rar",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".odt",
  ".ods",
  ".odp",
  ".pages",
  ".key",
  ".numbers",
]);

/**
 * Native Gateway attachment provider. It preserves the existing model-visible
 * attachment projection while keeping upload retention and Gateway turn state
 * outside this provider.
 */
export class GatewayAttachmentTurnComposer implements GatewayAttachmentTurnComposerPort {
  private readonly attachmentResolver: AttachmentResolver;

  constructor(options: GatewayAttachmentTurnComposerOptions = {}) {
    this.attachmentResolver = options.attachmentResolver ?? new AttachmentResolver();
  }

  async prepare(input: GatewayAttachmentTurnComposerInput): Promise<GatewayAttachmentTurnComposition> {
    const allowedReadFiles = await collectRegisteredAttachmentReadFiles(input.attachments);
    const resolvedAttachments = await attachmentsToContentBlocks(input.attachments, this.attachmentResolver);
    const pathNote = buildAttachmentPathNote(
      input.attachments,
      new Set(allowedReadFiles),
      resolvedAttachments.directContentPaths,
      resolvedAttachments.hasDiagnostics,
      input.projectRoot,
      input.funasrInstallCommand,
    );
    if (resolvedAttachments.blocks.length === 0 && !pathNote) {
      return {
        agentInput: { type: "text", text: input.message },
        allowedReadFiles,
      };
    }

    const blocks: CanonicalContentBlock[] = [];
    if (input.message.length > 0) {
      blocks.push({ type: "text", text: input.message });
    }
    blocks.push(...resolvedAttachments.blocks);
    if (pathNote) {
      blocks.push(pathNote);
    }
    return {
      agentInput: { type: "blocks", content: blocks },
      allowedReadFiles,
    };
  }
}

function buildAttachmentPathNote(
  attachments: ChannelAttachment[] | undefined,
  allowedReadFiles: Set<string>,
  directContentPaths: Set<string>,
  hasDiagnostics: boolean,
  projectRoot?: string,
  installCommand = "npm run install:asr",
): CanonicalContentBlock | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const attachment of attachments) {
    if (!attachment.path) continue;
    const normalized = safeAllowedAttachmentPath(attachment.path, allowedReadFiles);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const fallbackName = normalized.split(/[\\/]/).pop() || "attachment";
    const name = String(attachment.name || fallbackName).replace(/[\r\n]+/g, " ").trim() || fallbackName;
    lines.push(`- ${name}: ${normalized}`);
  }

  if (lines.length === 0) return undefined;
  const guidance = hasDiagnostics
    || attachments.some(isAudioAttachment)
    || attachments.some((attachment) => !isReadFileInspectableAttachment(attachment))
    ? attachmentDiagnosticsGuidance(attachments, allowedReadFiles, projectRoot, installCommand)
    : "These are path references for reuse. If an image/PDF is already visible in this turn, do not call read_file just to view it.";
  return {
    type: "text",
    text: `\n\n${ATTACHMENT_PATH_NOTE_MARKER}\n${lines.join("\n")}\n${guidance}`,
  };
}

function attachmentDiagnosticsGuidance(
  attachments: ChannelAttachment[],
  allowedReadFiles: Set<string>,
  projectRoot?: string,
  installCommand = "npm run install:asr",
): string {
  const audioAttachments = attachments.filter((attachment) => isAudioAttachment(attachment));
  if (audioAttachments.length > 0) {
    const audioPaths = audioAttachments
      .map((attachment) => attachment.path && mapAudioPathForFunAsr(attachment.path, projectRoot))
      .filter((path): path is string => Boolean(path));
    const mappedHint = audioPaths.length > 0
      ? ` Pass the registered project-local path${audioPaths.length === 1 ? ` ${audioPaths[0]}` : "s " + audioPaths.join(", ")} to transcribe_audio.`
      : " Pass a project-local host path to transcribe_audio; paths outside this project are rejected.";
    return `Audio attachments are not readable with read_file. When the user asks for transcription, subtitles, or audio analysis, use the funasr MCP server's mcp__funasr__transcribe_audio tool.${mappedHint} If that tool reports that its runtime is missing, run ${installCommand} and retry the tool in this session.`;
  }

  const hasInspectableAttachment = attachments.some((attachment) => {
    if (!attachment.path) return false;
    if (!safeAllowedAttachmentPath(attachment.path, allowedReadFiles)) return false;
    return isReadFileInspectableAttachment(attachment);
  });
  if (!hasInspectableAttachment) {
    return "Some attachments were not shown inline. These registered files are not directly inspectable with read_file; ask for a supported export or convert them before inspection.";
  }
  return "Some attachments were not shown inline. Use read_file with the exact path only for readable text, image, PDF, or notebook attachments; Office/archive/binary files need conversion before inspection.";
}

function isReadFileInspectableAttachment(attachment: ChannelAttachment): boolean {
  const mimeType = attachment.mimeType?.toLowerCase() ?? "";
  if (attachment.type === "image" || mimeType.startsWith("image/")) return true;
  if (mimeType === "application/pdf") return true;
  if (mimeType.startsWith("text/")) return true;
  if (mimeType === "application/json" || mimeType.endsWith("+json")) return true;

  const pathOrName = attachment.name || attachment.path || "";
  const extension = extname(pathOrName).toLowerCase();
  if (extension === ".pdf" || extension === ".ipynb") return true;
  if (READ_FILE_BINARY_ATTACHMENT_EXTENSIONS.has(extension)) return false;
  return true;
}

function safeAllowedAttachmentPath(path: string, allowedReadFiles: Set<string>): string | undefined {
  const normalized = resolve(path);
  if (allowedReadFiles.has(normalized)) return normalized;
  return undefined;
}

async function collectRegisteredAttachmentReadFiles(
  attachments: ChannelAttachment[] | undefined,
): Promise<string[]> {
  if (!attachments || attachments.length === 0) return [];
  const allowed = new Set<string>();

  for (const attachment of attachments) {
    if (!attachment.path || !attachment.metadata?.channelKey) continue;
    try {
      const info = await stat(attachment.path);
      if (!info.isFile()) continue;
      allowed.add(resolve(attachment.path));
      allowed.add(resolve(await realpath(attachment.path)));
    } catch {
      // Missing or inaccessible attachments are handled by attachment resolution diagnostics.
    }
  }

  return [...allowed];
}

async function attachmentsToContentBlocks(
  attachments: ChannelAttachment[] | undefined,
  attachmentResolver: AttachmentResolver,
): Promise<{ blocks: CanonicalContentBlock[]; directContentPaths: Set<string>; hasDiagnostics: boolean }> {
  if (!attachments || attachments.length === 0) {
    return { blocks: [], directContentPaths: new Set<string>(), hasDiagnostics: false };
  }
  const blocks: CanonicalContentBlock[] = [];
  const resolverRequests: Array<{
    request: AttachmentRequest;
    path?: string;
    registered: boolean;
  }> = [];
  const directContentPaths = new Set<string>();
  const diagnostics: string[] = [];

  for (const attachment of attachments) {
    if (attachment.type === "image" && attachment.content && attachment.mimeType) {
      blocks.push({
        type: "image",
        source: "base64",
        data: attachment.content,
        mimeType: attachment.mimeType,
        ...(typeof attachment.bytes === "number" ? { bytes: attachment.bytes } : {}),
      });
      if (attachment.path) directContentPaths.add(resolve(attachment.path));
      continue;
    }

    if (attachment.type === "text" && attachment.content) {
      blocks.push({ type: "text", text: attachment.content });
      continue;
    }

    if (!attachment.path) continue;
    if (isAudioAttachment(attachment)) {
      // Audio remains a registered path reference for the FunASR MCP consumer.
      continue;
    }
    if (attachment.type === "image" || attachment.mimeType?.startsWith("image/")) {
      resolverRequests.push({
        request: { type: "image", path: attachment.path, mimeType: attachment.mimeType },
        path: resolve(attachment.path),
        registered: Boolean(attachment.metadata?.channelKey),
      });
    } else if (attachment.mimeType === "application/pdf" || attachment.path.toLowerCase().endsWith(".pdf")) {
      resolverRequests.push({
        request: { type: "pdf", path: attachment.path },
        path: resolve(attachment.path),
        registered: Boolean(attachment.metadata?.channelKey),
      });
    } else {
      resolverRequests.push({
        request: { type: "file", path: attachment.path },
        path: resolve(attachment.path),
        registered: Boolean(attachment.metadata?.channelKey),
      });
    }
  }

  if (resolverRequests.length > 0) {
    for (const item of resolverRequests) {
      const resolved = await attachmentResolver.resolve(item.request);
      blocks.push(...resolved.blocks);
      for (const diagnostic of resolved.diagnostics) {
        if (diagnostic.severity === "error" || diagnostic.severity === "warning" || !item.registered) {
          diagnostics.push(diagnostic.message);
        }
      }
      if (resolved.blocks.length > 0 && resolved.diagnostics.length === 0 && item.path) {
        directContentPaths.add(item.path);
      }
    }
  }

  if (diagnostics.length > 0) {
    blocks.push({
      type: "text",
      text: `[Attachment diagnostics]\n${diagnostics.map((message) => `- ${message}`).join("\n")}`,
    });
  }

  return { blocks, directContentPaths, hasDiagnostics: diagnostics.length > 0 };
}

function isAudioAttachment(attachment: ChannelAttachment): boolean {
  if (attachment.mimeType?.toLowerCase().startsWith("audio/")) return true;
  const pathOrName = attachment.path || attachment.name || "";
  return /\.(?:aac|flac|m4a|mp3|oga|ogg|opus|wav|webm)$/iu.test(pathOrName);
}

function mapAudioPathForFunAsr(audioPath: string, projectRoot?: string): string | undefined {
  if (!projectRoot) return undefined;
  const absoluteRoot = resolve(projectRoot);
  const absolutePath = resolve(audioPath);
  const relativePath = relative(absoluteRoot, absolutePath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return undefined;
  }
  return absolutePath;
}
