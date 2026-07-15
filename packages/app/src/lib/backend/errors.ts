export type BackendErrorCategory =
  | "Conflict"
  | "Forbidden"
  | "NotFound"
  | "Unauthenticated"
  | "RateLimited"
  | "Unsupported"
  | "Unknown";

export class BackendError extends Error {
  readonly category: BackendErrorCategory;
  readonly operation: string;
  readonly status?: number;
  readonly code?: string;
  readonly cause?: unknown;

  constructor(args: {
    category: BackendErrorCategory;
    operation: string;
    message: string;
    status?: number;
    code?: string;
    cause?: unknown;
  }) {
    super(args.message);
    this.name = "BackendError";
    this.category = args.category;
    this.operation = args.operation;
    this.status = args.status;
    this.code = args.code;
    this.cause = args.cause;
  }
}

type SupabaseLikeError = {
  status?: unknown;
  code?: unknown;
  message?: unknown;
  name?: unknown;
};

function errorRecord(error: unknown): SupabaseLikeError {
  return error && typeof error === "object" ? (error as SupabaseLikeError) : {};
}

function normalizeStatus(status: unknown): number | undefined {
  if (typeof status === "number") return status;
  if (typeof status === "string" && status.trim() !== "") {
    const parsed = Number(status);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeCode(code: unknown): string | undefined {
  return typeof code === "string" && code.trim() !== "" ? code : undefined;
}

function categoryFor(error: SupabaseLikeError): BackendErrorCategory {
  const status = normalizeStatus(error.status);
  const code = normalizeCode(error.code);

  if (code === "23505") return "Conflict";
  if (code === "42501" || status === 403) return "Forbidden";
  if (code === "PGRST116" || status === 404) return "NotFound";
  if (status === 401) return "Unauthenticated";
  if (status === 429) return "RateLimited";
  return "Unknown";
}

function messageFor(error: unknown, operation: string): string {
  const record = errorRecord(error);
  if (typeof record.message === "string" && record.message.trim() !== "") {
    return record.message;
  }
  if (typeof record.name === "string" && record.name.trim() !== "") {
    return `${operation} failed: ${record.name}`;
  }
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  return `${operation} failed`;
}

export function toBackendError(error: unknown, operation: string): BackendError {
  if (error instanceof BackendError) return error;

  const record = errorRecord(error);
  return new BackendError({
    category: categoryFor(record),
    operation,
    message: messageFor(error, operation),
    status: normalizeStatus(record.status),
    code: normalizeCode(record.code),
    cause: error,
  });
}
