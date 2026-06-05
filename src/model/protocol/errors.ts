export type CanonicalModelErrorCode =
  | "prompt_too_long"
  | "request_too_large"
  | "max_output_reached"
  | "rate_limit_error"
  | "auth_error"
  | "server_error"
  | "timeout"
  | "overloaded_error"
  | "invalid_request"
  | "provider_error"
  | "billing"
  | "model_not_found"
  | "context_overflow"
  | "image_too_large"
  | "payload_too_large"
  | "unknown";

export type SettingsFix = {
  description: string;
  configPath?: string;
  command?: string;
  url?: string;
};

export type CanonicalModelError = {
  provider: string;
  protocol: "anthropic" | "openai";
  code: CanonicalModelErrorCode | (string & {});
  status?: number;
  message: string;
  retryable: boolean;
  raw?: unknown;
  /** True for prompt-too-long errors that context recovery can attempt to resolve. */
  recoverableViaCompact?: boolean;
  /** True for multimodal processor errors recoverable by stripping images from context. */
  recoverableViaImageStrip?: boolean;
  /** User-facing one-line actionable hint for resolving this error. */
  userHint?: string;
  /** Structured settings fix info — config path, CLI command, or URL the user can act on. */
  settingsFix?: SettingsFix;
};

export const PROMPT_TOO_LONG_ANTHROPIC_PATTERN = /prompt is too long/i;
export const PROMPT_TOO_LONG_OPENAI_PATTERN = /input length and max_tokens exceed context limit/i;
export const REQUEST_TOO_LARGE_PATTERN = /request too large/i;
export const MAX_OUTPUT_REACHED_PATTERN = /max(?:imum)? (?:output|completion) tokens? (?:exceeded|reached)/i;
export const MULTIMODAL_PROCESSOR_PATTERN = /failed to apply.*processor/i;

export const CONTEXT_OVERFLOW_PATTERN =
  /context length|context size|maximum context|token limit|too many tokens|reduce the length|context window|prompt exceeds max length|max_tokens|maximum number of tokens|exceeds the max_model_len|max_model_len|input is too long|maximum model length|context length exceeded|slot context|n_ctx_slot|超过最大长度|上下文长度|input token|exceeds the maximum number of input tokens/i;

export const BILLING_PATTERN =
  /insufficient credits|insufficient_quota|insufficient balance|credit balance|credits have been exhausted|top up your credits|payment required|billing hard limit|exceeded your current quota|account is deactivated|plan does not include/i;

export const MODEL_NOT_FOUND_PATTERN =
  /is not a valid model|invalid model|model not found|model_not_found|does not exist|no such model|unknown model|unsupported model/i;

export const IMAGE_TOO_LARGE_PATTERN =
  /image exceeds|image too large|image_too_large|image size exceeds/i;

export const RATE_LIMIT_MESSAGE_PATTERN =
  /rate limit|rate_limit|too many requests|throttled|requests per minute|tokens per minute|try again in|please retry after|resource_exhausted/i;

export const TRANSIENT_USAGE_SIGNAL_PATTERN =
  /try again|retry|resets at|reset in|wait|requests remaining|window/i;

export const USAGE_LIMIT_PATTERN =
  /usage limit|quota|limit exceeded|key limit exceeded/i;

export class ModelConfigError extends Error {
  readonly name = "ModelConfigError";

  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class ModelRequestError extends Error {
  readonly name = "ModelRequestError";

  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class ModelProviderError extends Error {
  readonly name = "ModelProviderError";

  constructor(readonly error: CanonicalModelError) {
    super(error.message);
  }
}
