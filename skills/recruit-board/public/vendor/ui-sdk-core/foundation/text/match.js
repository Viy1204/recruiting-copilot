// src/foundation/text/match.ts
import { userLocale } from "./locale.js";
var latinLetters = "abcdefghijklmnopqrstuvwxyz";
var diacritics = /\p{Diacritic}/gu;
var latin = /\p{Script=Latin}/u;
var ascii = /^[\u0000-\u007f]*$/;
var specialCase = /^(tr|az|lt)\b/i;
function createFolder(locale) {
  const collator = new Intl.Collator(locale, {
    sensitivity: "base",
    usage: "search"
  });
  const lower = specialCase.test(locale ?? "") ? (text) => text.toLocaleLowerCase(locale) : (text) => text.toLowerCase();
  const chars = /* @__PURE__ */ new Map();
  const texts = /* @__PURE__ */ new Map();
  function foldChar(char) {
    let folded = chars.get(char);
    if (folded !== void 0) {
      return folded;
    }
    const lowered = lower(char);
    if (char < "\x80") {
      chars.set(char, lowered);
      return lowered;
    }
    const stripped = lower(char.normalize("NFD").replace(diacritics, ""));
    if (stripped.length === char.length && stripped !== lowered && collator.compare(char, stripped) === 0) {
      folded = stripped;
    } else if (latin.test(char)) {
      folded = [...latinLetters].find(
        (letter) => collator.compare(char, letter) === 0
      );
    }
    folded ??= lowered.length === char.length ? lowered : char;
    chars.set(char, folded);
    return folded;
  }
  function fold(text) {
    let folded = texts.get(text);
    if (folded !== void 0) {
      return folded;
    }
    if (ascii.test(text)) {
      folded = lower(text);
    } else {
      folded = "";
      for (const char of text) {
        folded += foldChar(char);
      }
    }
    if (texts.size > 5e4) {
      texts.clear();
    }
    texts.set(text, folded);
    return folded;
  }
  return { locale, fold };
}
var folder;
var watching = false;
function setMatchLocale(locale) {
  folder = createFolder(locale ?? userLocale());
}
function userFolder() {
  if (folder) {
    return folder;
  }
  if (!watching && typeof window !== "undefined") {
    watching = true;
    window.addEventListener("languagechange", () => folder = void 0);
  }
  return folder = createFolder(userLocale());
}
var foldText = (text) => userFolder().fold(text);
function leadingSpaces(text) {
  let index = 0;
  while (index < text.length && text.charCodeAt(index) <= 32) {
    index++;
  }
  return index;
}
var separators = /* @__PURE__ */ new Set([
  " ",
  "-",
  "_",
  "/",
  ".",
  ":",
  ",",
  "(",
  ")",
  "[",
  "]",
  "@",
  "#"
]);
var startsWord = (text, index) => index === 0 || separators.has(text[index - 1]);
function matchRanges(text, query, mode) {
  const needle = foldText(query.trim());
  if (!needle) {
    return [];
  }
  const haystack = foldText(text);
  const index = haystack.indexOf(needle);
  if (mode === "startsWith") {
    const start = leadingSpaces(haystack);
    return haystack.startsWith(needle, start) ? [{ start, end: start + needle.length }] : [];
  }
  if (index !== -1) {
    const start = mode === "fuzzy" ? wordStart(haystack, needle, index) : index;
    return [{ start, end: start + needle.length }];
  }
  return mode === "fuzzy" ? letterRanges(haystack, needle) : [];
}
function wordStart(haystack, needle, first) {
  for (let index = first; index !== -1; index = haystack.indexOf(needle, index + 1)) {
    if (startsWord(haystack, index)) {
      return index;
    }
  }
  return first;
}
function letterRanges(haystack, needle) {
  const ranges = [];
  let position = 0;
  for (const char of needle) {
    if (char === " ") {
      continue;
    }
    const found = haystack.indexOf(char, position);
    if (found === -1) {
      return [];
    }
    const last = ranges.at(-1);
    if (last && last.end === found) {
      last.end = found + 1;
    } else {
      ranges.push({ start: found, end: found + 1 });
    }
    position = found + 1;
  }
  return ranges;
}
function matchSegments(text, ranges) {
  if (!ranges.length) {
    return [{ text, match: false }];
  }
  const segments = [];
  let position = 0;
  for (const { start, end } of ranges) {
    if (start > position) {
      segments.push({ text: text.slice(position, start), match: false });
    }
    segments.push({ text: text.slice(start, end), match: true });
    position = end;
  }
  if (position < text.length) {
    segments.push({ text: text.slice(position), match: false });
  }
  return segments;
}
export {
  createFolder,
  foldText,
  leadingSpaces,
  matchRanges,
  matchSegments,
  setMatchLocale,
  startsWord
};
