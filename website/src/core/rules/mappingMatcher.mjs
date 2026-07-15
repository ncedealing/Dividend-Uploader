import { evaluateAccountScope } from "./accountScope.mjs";
import {
  compareRuleSpecificity,
  matchesPattern,
  patternSpecificity,
  platformMatches,
} from "./patterns.mjs";

function candidateFromMapping(mapping, subject) {
  if (!mapping?.enabled) {
    return null;
  }
  if (!platformMatches(mapping.platform, subject.platform)) {
    return null;
  }
  if (!matchesPattern(subject.symbol, mapping.mtSymbolMask)) {
    return null;
  }

  const accountScope = evaluateAccountScope(subject, mapping.accountScope ?? {});
  if (!accountScope.allowed) {
    return null;
  }

  const specificity = patternSpecificity(mapping.mtSymbolMask);
  return {
    mapping,
    accountScope,
    id: mapping.id,
    priority: Number(mapping.priority ?? 1000),
    ...specificity,
  };
}

function sameWinningRank(a, b) {
  return (
    a.exact === b.exact &&
    a.priority === b.priority &&
    a.wildcardCount === b.wildcardCount &&
    a.literalLength === b.literalLength
  );
}

export function matchMapping(subject, mappings = []) {
  const candidates = mappings
    .map((mapping) => candidateFromMapping(mapping, subject))
    .filter(Boolean)
    .sort(compareRuleSpecificity);

  if (candidates.length === 0) {
    return {
      status: "missing",
      mapping: null,
      candidates: [],
      conflictCandidates: [],
      message: `No enabled mapping matched ${subject.platform}:${subject.symbol}`,
    };
  }

  const winner = candidates[0];
  const conflictCandidates = candidates.filter((candidate) => sameWinningRank(candidate, winner));

  if (conflictCandidates.length > 1) {
    return {
      status: "conflict",
      mapping: null,
      candidates,
      conflictCandidates: conflictCandidates.map((candidate) => candidate.mapping),
      message: `Conflicting mapping rules for ${subject.platform}:${subject.symbol}: ${conflictCandidates
        .map((candidate) => candidate.mapping.id)
        .join(", ")}`,
    };
  }

  return {
    status: "matched",
    mapping: winner.mapping,
    candidates,
    conflictCandidates: [],
    matchedMask: winner.mapping.mtSymbolMask,
    accountScope: winner.accountScope,
  };
}
