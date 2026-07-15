import { matchesPattern, splitRuleList } from "./patterns.mjs";

function parseScopeList(input) {
  const includes = [];
  const excludes = [];

  for (const rawRule of splitRuleList(input)) {
    if (rawRule.startsWith("!")) {
      const pattern = rawRule.slice(1).trim();
      if (pattern) {
        excludes.push(pattern);
      }
    } else {
      includes.push(rawRule);
    }
  }

  return { includes, excludes };
}

export function evaluateScopeValue(value, rawRules) {
  const { includes, excludes } = parseScopeList(rawRules);
  const text = String(value ?? "");
  const matchedExclude = excludes.find((pattern) => matchesPattern(text, pattern));

  if (matchedExclude) {
    return {
      allowed: false,
      matchedInclude: null,
      matchedExclude,
      effectiveIncludes: includes.length === 0 ? ["*"] : includes,
    };
  }

  const effectiveIncludes = includes.length === 0 && excludes.length > 0 ? ["*"] : includes;
  const matchedInclude =
    effectiveIncludes.length === 0
      ? null
      : effectiveIncludes.find((pattern) => matchesPattern(text, pattern)) ?? null;

  return {
    allowed: effectiveIncludes.length === 0 || matchedInclude != null,
    matchedInclude,
    matchedExclude: null,
    effectiveIncludes,
  };
}

export function evaluateAccountScope(subject, scope = {}) {
  if (scope?.enabled === false) {
    return {
      allowed: true,
      group: { allowed: true, matchedInclude: null, matchedExclude: null },
      login: { allowed: true, matchedInclude: null, matchedExclude: null },
    };
  }

  const groupRules = scope?.groupMasks ?? "*";
  const loginRules = scope?.loginMasks ?? "*";
  const group = evaluateScopeValue(subject?.group ?? "", groupRules);
  const login = evaluateScopeValue(subject?.login ?? "", loginRules);

  return {
    allowed: group.allowed && login.allowed,
    group,
    login,
  };
}
