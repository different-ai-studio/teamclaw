type UnknownRecord = Record<string, unknown>;

export function sessionIdFromNotificationData(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const direct =
    normalizeSessionId(data.session_id) ??
    normalizeSessionId(data.sessionId) ??
    normalizeSessionId(data.session);
  if (direct) return direct;
  if (isRecord(data.data)) return sessionIdFromNotificationData(data.data);
  return null;
}

export function notificationResponseToSessionHref(response: unknown): string | null {
  const data = notificationResponseData(response);
  const sessionId = sessionIdFromNotificationData(data);
  return sessionId ? `/(app)/sessions/${encodeURIComponent(sessionId)}` : null;
}

export function notificationResponseDedupeKey(response: unknown): string | null {
  const href = notificationResponseToSessionHref(response);
  if (!href) return null;
  const request = notificationRequest(response);
  const identifier = isRecord(request)
    ? normalizeSessionId(request.identifier)
    : null;
  return identifier ? `${identifier}:${href}` : href;
}

function notificationResponseData(response: unknown): unknown {
  const request = notificationRequest(response);
  if (!isRecord(request)) return null;
  const content = request.content;
  if (!isRecord(content)) return null;
  return content.data;
}

function notificationRequest(response: unknown): unknown {
  if (!isRecord(response)) return null;
  const notification = response.notification;
  if (!isRecord(notification)) return null;
  return notification.request;
}

function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}
