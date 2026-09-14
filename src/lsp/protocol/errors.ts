export type LspErrorCode =
  | "LSP_INVALID_PROVIDER"
  | "LSP_CONFLICT"
  | "LSP_UNAVAILABLE"
  | "LSP_DISPOSED"
  | "LSP_UNSUPPORTED_OPERATION"
  | "LSP_MALFORMED_RESPONSE"
  | "LSP_WORKSPACE_REQUIRED"
  | "LSP_TIMEOUT";

export class LspError extends Error {
  readonly code: LspErrorCode;

  constructor(message: string, code: LspErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "LspError";
    this.code = code;
  }
}
