/**
 * Clause splitting for prose. Takes the raw source text of one paragraph
 * (which may contain hard-wrapped newlines) and returns the spans of its
 * clauses. The whitespace between clause spans is the separator; the
 * projection replaces it with a synthetic line break.
 */

export interface ClauseSpan {
  /** Offset of the first character of the clause, relative to the input. */
  start: number
  /** Offset just past the last character of the clause. */
  end: number
}

export const DEFAULT_CONJUNCTION_MIN_LENGTH = 60

const SENTENCE_END = new Set([".", "!", "?", "…"])
const CLOSERS = new Set(['"', "'", "”", "’", ")", "]"])

/**
 * Abbreviations that end with a period but do not end a sentence. Compared
 * against the lowercased word preceding the period, with internal periods
 * kept ("e.g" for "e.g.").
 */
const ABBREVIATIONS = new Set([
  "e.g",
  "i.e",
  "etc",
  "vs",
  "cf",
  "ca",
  "al",
  "dr",
  "mr",
  "mrs",
  "ms",
  "prof",
  "fig",
  "eq",
  "sec",
  "ch",
  "st",
  "no",
  "vol",
  "pp",
  "approx",
])

const CONJUNCTION_RE = /^,([ \t]+)(and|but|or|nor|yet|so)(?=[\s])/

/**
 * Matches a coordinating conjunction not preceded by a comma, with the
 * leading whitespace as the separator group. Used for compound sentences
 * like "…long clause and I did a thing" where the comma is omitted.
 */
const NO_COMMA_CONJ_RE = /^([ \t]+)(and|but|or|nor|yet|so)([ \t]+)/i

/**
 * Subject pronouns that, when appearing in the first few words after a
 * conjunction, indicate a new independent clause rather than a coordinated
 * phrase or prepositional attachment.
 */
const SUBJECT_PRONOUN_RE = /^(I|you|he|she|we|they|it)$/i

function looksLikeNewClause(text: string, startIdx: number): boolean {
  const ahead = text.slice(startIdx, startIdx + 60)
  const words = ahead.split(/\s+/).filter(Boolean).slice(0, 6)
  return words.some((w) => SUBJECT_PRONOUN_RE.test(w))
}

function precedingWord(text: string, periodIndex: number): string {
  let i = periodIndex - 1
  while (i >= 0 && /[A-Za-z.]/.test(text[i])) i--
  return text.slice(i + 1, periodIndex)
}

function isAbbreviationPeriod(text: string, periodIndex: number): boolean {
  if (text[periodIndex] !== ".") return false
  const word = precedingWord(text, periodIndex)
  if (word.length === 0) return false
  const normalized = word.toLowerCase().replace(/\.$/, "")
  if (ABBREVIATIONS.has(normalized)) return true
  // Single-letter initials: "J. Smith", "U.S. policy" handled via the word
  // containing periods ("U.S") or being one letter.
  if (/^[A-Za-z]$/.test(word)) return true
  if (/^[A-Za-z](\.[A-Za-z])+$/.test(word)) return true
  return false
}

/**
 * Split paragraph text into clause spans.
 *
 * Breaks:
 *  - after sentence-ending punctuation (with closing quotes/brackets kept on
 *    the left clause), unless the period belongs to an abbreviation
 *  - before a coordinating conjunction following a comma, when the clause so
 *    far is at least `conjunctionMinLength` characters
 *
 * Never breaks inside inline code spans, brackets (links, citations like
 * [@doe2020]), or parentheses.
 */
export function splitClauses(
  text: string,
  conjunctionMinLength: number = DEFAULT_CONJUNCTION_MIN_LENGTH
): ClauseSpan[] {
  // Each break is [separatorStart, separatorEnd): the whitespace consumed
  // between two clauses.
  const breaks: Array<[number, number]> = []

  let i = 0
  let clauseStart = 0
  let inCode = false
  let bracketDepth = 0
  let parenDepth = 0

  while (i < text.length) {
    const ch = text[i]

    if (ch === "`") {
      inCode = !inCode
      i++
      continue
    }
    if (inCode) {
      i++
      continue
    }

    if (ch === "[") bracketDepth++
    else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1)
    else if (ch === "(") parenDepth++
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1)

    if (bracketDepth === 0 && parenDepth === 0) {
      if (SENTENCE_END.has(ch)) {
        let j = i + 1
        while (j < text.length && CLOSERS.has(text[j])) j++
        const followedByWhitespace = j < text.length && /\s/.test(text[j])
        if (followedByWhitespace && !isAbbreviationPeriod(text, i)) {
          let k = j
          while (k < text.length && /\s/.test(text[k])) k++
          if (k < text.length) {
            breaks.push([j, k])
            i = k
            clauseStart = k
            continue
          }
        }
      } else if (ch === ",") {
        const m = CONJUNCTION_RE.exec(text.slice(i, i + 12))
        if (m && i + 1 - clauseStart >= conjunctionMinLength) {
          const sepStart = i + 1
          const sepEnd = sepStart + m[1].length
          breaks.push([sepStart, sepEnd])
          i = sepEnd
          clauseStart = sepEnd
          continue
        }
      } else if (ch === " " || ch === "\t") {
        // No-comma compound clause: "…long clause and I did a thing".
        // Only fires when the subject-pronoun check confirms a new clause
        // follows, so "X and Y" noun phrases don't get split.
        const m = NO_COMMA_CONJ_RE.exec(text.slice(i))
        if (m && i - clauseStart >= conjunctionMinLength) {
          const afterConj = i + m[0].length
          if (looksLikeNewClause(text, afterConj)) {
            // Separator is the leading whitespace only; the conjunction
            // starts the new clause.
            const sepStart = i
            const sepEnd = i + m[1].length
            breaks.push([sepStart, sepEnd])
            i = sepEnd
            clauseStart = sepEnd
            continue
          }
        }
      }
    }

    i++
  }

  // Assemble spans between breaks, trimming whitespace at the edges.
  const spans: ClauseSpan[] = []
  let cursor = 0
  for (const [sepStart, sepEnd] of breaks) {
    pushTrimmed(spans, text, cursor, sepStart)
    cursor = sepEnd
  }
  pushTrimmed(spans, text, cursor, text.length)
  return spans
}

function pushTrimmed(spans: ClauseSpan[], text: string, start: number, end: number): void {
  while (start < end && /\s/.test(text[start])) start++
  while (end > start && /\s/.test(text[end - 1])) end--
  if (end > start) spans.push({ start, end })
}
