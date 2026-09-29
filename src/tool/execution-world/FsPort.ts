/** Minimal file metadata exposed by an execution-world filesystem provider. */
export type FsFileStat = {
  kind: "file" | "directory" | "other";
  size: number;
  mtimeMs: number;
};

/** Host-independent directory entry exposed by the execution-world filesystem provider. */
export type FsDirectoryEntry = {
  name: string;
  kind: "file" | "directory" | "other";
};

/** Encoding options understood by the host-independent read contract. */
export type FsReadFileOptions = {
  encoding?: "utf8";
  signal?: AbortSignal;
};

/** Host-independent result for a line-oriented text read. */
export type FsReadRangeResult = {
  content: string;
  fullContent?: string;
  lineCount: number;
  totalLines: number;
  totalBytes: number;
  readBytes: number;
  mtimeMs: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
};

/** Consumer-controlled write options for the filesystem contract. */
export type FsWriteTextOptions = {
  allowOverwrite?: boolean;
  signal?: AbortSignal;
  /**
   * Workspace authorized by the filesystem consumer for this mutation.
   * Constraining providers require it for `workspace-write`; native providers
   * ignore it and preserve the existing filesystem contract.
   */
  workspaceRoot?: string;
};

/** Result of an atomically published text write. */
export type FsWriteTextResult = {
  action: "created" | "overwritten";
  mtimeMs: number;
};

/** Host-independent filesystem capability consumed by filesystem tools. */
export type FsPort = {
  stat(path: string, signal?: AbortSignal): Promise<FsFileStat>;
  /** Lists immediate children without following symlinks. */
  readDirectory(path: string, signal?: AbortSignal): Promise<FsDirectoryEntry[]>;
  readFile(path: string, options?: FsReadFileOptions): Promise<Uint8Array | string>;
  readFileInRange(
    path: string,
    startLine: number,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<FsReadRangeResult>;
  writeText(path: string, content: string, options?: FsWriteTextOptions): Promise<FsWriteTextResult>;
};
