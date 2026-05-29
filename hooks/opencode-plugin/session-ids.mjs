const SESSION_ID_PREFIX = "opencode:";
const DEFAULT_SESSION_ID = `${SESSION_ID_PREFIX}default`;

function normalizeOpencodeSessionId(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;
  return value.startsWith(SESSION_ID_PREFIX) ? value : `${SESSION_ID_PREFIX}${value}`;
}

function getEventSessionId(event) {
  const sid = event && event.properties && event.properties.sessionID;
  return typeof sid === "string" && sid.trim() ? sid.trim() : null;
}

function resolveOpencodeSessionId(raw, fallback) {
  return normalizeOpencodeSessionId(raw)
    || normalizeOpencodeSessionId(fallback)
    || DEFAULT_SESSION_ID;
}

function shouldDropMappedEventWithoutSessionId(event, mapped) {
  return !!(mapped && mapped.event === "SessionEnd" && !getEventSessionId(event));
}

export {
  DEFAULT_SESSION_ID,
  normalizeOpencodeSessionId,
  getEventSessionId,
  resolveOpencodeSessionId,
  shouldDropMappedEventWithoutSessionId,
};
