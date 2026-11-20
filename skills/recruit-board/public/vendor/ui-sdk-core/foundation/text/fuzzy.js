// src/foundation/text/fuzzy.ts
import { normalize } from "./typeahead.js";
import { startsWord } from "./match.js";
var coverage = (needle, haystack) => 0.09 * needle.length / haystack.length;
function wordStartIndex(haystack, needle, from) {
  for (let index = from; index !== -1; index = haystack.indexOf(needle, index + 1)) {
    if (startsWord(haystack, index)) {
      return index;
    }
  }
  return -1;
}
function subsequenceScore(haystack, needle) {
  let position = 0;
  let previous = -2;
  let bonus = 0;
  let letters = 0;
  for (const char of needle) {
    if (char === " ") {
      continue;
    }
    const found = haystack.indexOf(char, position);
    if (found === -1) {
      return 0;
    }
    letters++;
    if (startsWord(haystack, found)) {
      bonus += 1;
    }
    if (found === previous + 1) {
      bonus += 1;
    }
    previous = found;
    position = found + 1;
  }
  if (!letters) {
    return 0;
  }
  return 0.1 + 0.4 * bonus / (2 * letters);
}
function fuzzyScore(text, query) {
  const needle = normalize(query);
  if (!needle) {
    return 1;
  }
  const haystack = normalize(text);
  if (haystack === needle) {
    return 1;
  }
  const index = haystack.indexOf(needle);
  if (index === 0) {
    return 0.9 + coverage(needle, haystack);
  }
  if (index > 0) {
    return (wordStartIndex(haystack, needle, index) !== -1 ? 0.75 : 0.6) + coverage(needle, haystack);
  }
  return subsequenceScore(haystack, needle);
}
function fuzzyFilter(item, query) {
  let best = fuzzyScore(item.label, query);
  for (const keyword of item.keywords ?? []) {
    best = Math.max(best, fuzzyScore(keyword, query) * 0.95);
  }
  return best;
}
export {
  fuzzyFilter,
  fuzzyScore
};
