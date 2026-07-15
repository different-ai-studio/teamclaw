export type OpenCodeMessage = {
  info: Record<string, unknown>;
  parts: Array<Record<string, unknown>>;
};

export type SessionExportOptions = {
  includeThinking?: boolean;
  includeTools?: boolean;
  sanitize?: boolean;
  includeSystem?: boolean;
};

export type SessionExportBundle = {
  session_id: string;
  exported_at: string;
  source: {
    type: string;
    base_url?: string;
    endpoint?: string;
  };
  messages: OpenCodeMessage[];
};
