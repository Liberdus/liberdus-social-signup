// Shared JSON helpers for DB-backed JSON columns. They intentionally accept
// only plain objects because provider raw profiles and verification snapshots
// are expected to be object payloads, never arrays or primitives.
function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;

  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringifyJsonObject(value) {
  return JSON.stringify(value && typeof value === "object" && !Array.isArray(value) ? value : {});
}

module.exports = {
  parseJsonObject,
  stringifyJsonObject
};
