export function splitRuleList(input) {
  if (input == null) {
    return [];
  }

  const values = Array.isArray(input) ? input : [input];
  return values
    .flatMap((value) => String(value).split(/[,，;\n\r]+/u))
    .map((value) => value.trim())
    .filter(Boolean);
}

export function hasWildcard(pattern) {
  return /[*?]/u.test(String(pattern));
}

export function wildcardToRegExp(pattern, { caseSensitive = true } = {}) {
  const source = String(pattern)
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, ".*")
    .replace(/\?/gu, ".");
  return new RegExp(`^${source}$`, caseSensitive ? "u" : "iu");
}

export function matchesPattern(value, pattern, options = {}) {
  return wildcardToRegExp(pattern, options).test(String(value ?? ""));
}

export function findMatchedMask(value, masks, options = {}) {
  const normalizedMasks = splitRuleList(masks);
  return normalizedMasks.find((mask) => matchesPattern(value, mask, options)) ?? null;
}

export function platformMatches(rulePlatform, targetPlatform) {
  const rule = String(rulePlatform ?? "both").toLowerCase();
  const target = String(targetPlatform ?? "").toLowerCase();
  return rule === "both" || rule === target;
}

export function patternSpecificity(pattern) {
  const text = String(pattern ?? "");
  const wildcardCount = [...text].filter((char) => char === "*" || char === "?").length;
  return {
    exact: wildcardCount === 0,
    wildcardCount,
    literalLength: text.length - wildcardCount,
  };
}

export function compareRuleSpecificity(a, b) {
  if (a.exact !== b.exact) {
    return a.exact ? -1 : 1;
  }
  if (a.priority !== b.priority) {
    return a.priority - b.priority;
  }
  if (a.wildcardCount !== b.wildcardCount) {
    return a.wildcardCount - b.wildcardCount;
  }
  if (a.literalLength !== b.literalLength) {
    return b.literalLength - a.literalLength;
  }
  return String(a.id).localeCompare(String(b.id));
}
