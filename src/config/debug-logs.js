const ENABLE_ALL = new Set(["1", "true", "yes", "on", "all", "*"]);
const DISABLE_ALL = new Set(["0", "false", "no", "off", "none"]);

export function isDebugLogEnabled(value, category) {
  const normalizedCategory = normalizeToken(category);
  if (!normalizedCategory) {
    return false;
  }

  const tokens = parseDebugLogTokens(value);
  if (tokens.length === 0) {
    return false;
  }

  if (tokens.some((token) => ENABLE_ALL.has(token))) {
    return true;
  }

  if (tokens.every((token) => DISABLE_ALL.has(token))) {
    return false;
  }

  return tokens.includes(normalizedCategory);
}

export function parseDebugLogTokens(value) {
  if (typeof value !== "string") {
    return [];
  }

  return value
    .split(/[,\s]+/)
    .map(normalizeToken)
    .filter(Boolean);
}

function normalizeToken(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
