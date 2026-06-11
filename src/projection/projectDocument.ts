import { Projection, ProjectedLine, ProjectedLineKind, ProjectedToken } from "../types/projection"
import { splitClauses, DEFAULT_CONJUNCTION_MIN_LENGTH } from "./semanticBreaks"

export interface ProjectOptions {
  /** When false, the projection is the identity: raw text, one token. */
  enabled?: boolean
  conjunctionMinLength?: number
}

type SourceLine = {
  /** Offset of the first character of the line. */
  start: number
  /** Offset just past the last character, excluding the newline. */
  end: number
  /** Offset of the newline character, or -1 when the file ends without one. */
  newlineAt: number
  text: string
}

type Segment =
  | { type: "verbatim"; line: SourceLine }
  | { type: "paragraph"; lines: SourceLine[] }
  | { type: "list-item"; line: SourceLine; markerWidth: number }

/**
 * Builds the semantic projection of a document.
 *
 * Invariants:
 *  - Prose paragraphs are split into clauses; each clause becomes one
 *    projected line, terminated by a synthetic newline. Hard wraps inside a
 *    clause are normalized to single spaces (via replacement tokens that keep
 *    their source span), which makes the projection reflow-resistant.
 *  - Everything Markdown-structural (frontmatter, fences, tables, lists,
 *    blockquotes, headings, indented code) is passed through verbatim, one
 *    source line per projected line.
 *  - The projection never invents content: every projected character either
 *    maps to a source span or is a synthetic newline.
 */
export function projectDocument(
  filePath: string,
  text: string,
  opts: ProjectOptions = {}
): Projection {
  if (opts.enabled === false) {
    return identityProjection(filePath, text)
  }
  const conjunctionMinLength = opts.conjunctionMinLength ?? DEFAULT_CONJUNCTION_MIN_LENGTH

  const sourceLines = scanLines(text)
  const segments = segment(sourceLines, text)

  const builder = new ProjectionBuilder(filePath, text)
  for (const seg of segments) {
    if (seg.type === "verbatim") {
      builder.emitVerbatimLine(seg.line)
    } else if (seg.type === "list-item") {
      builder.emitListItem(seg.line, seg.markerWidth, conjunctionMinLength)
    } else {
      builder.emitParagraph(seg.lines, conjunctionMinLength)
    }
  }
  return builder.finish()
}

function identityProjection(filePath: string, text: string): Projection {
  const tokens: ProjectedToken[] = text.length
    ? [{ text, sourceSpan: { startOffset: 0, endOffset: text.length }, synthetic: false }]
    : []
  const lines: ProjectedLine[] = []
  let projStart = 0
  let srcStart = 0
  const raw = text.split("\n")
  for (let i = 0; i < raw.length; i++) {
    const isLast = i === raw.length - 1
    if (isLast && raw[i] === "" && text.endsWith("\n")) break
    lines.push({
      text: raw[i],
      projStart,
      projEnd: projStart + raw[i].length,
      sourceSpan: { startOffset: srcStart, endOffset: srcStart + raw[i].length },
      syntheticEol: false,
      kind: "verbatim",
    })
    projStart += raw[i].length + 1
    srcStart += raw[i].length + 1
  }
  return { filePath, originalText: text, projectedText: text, tokens, lines }
}

function scanLines(text: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length) {
      if (start < i || (text.length > 0 && text[text.length - 1] === "\n" && start === i)) {
        if (start < i) lines.push({ start, end: i, newlineAt: -1, text: text.slice(start, i) })
      }
      break
    }
    if (text[i] === "\n") {
      lines.push({ start, end: i, newlineAt: i, text: text.slice(start, i) })
      start = i + 1
    }
  }
  return lines
}

const FENCE_RE = /^ {0,3}(```+|~~~+|:::+)/
const MATH_BLOCK_RE = /^ {0,3}\$\$\s*$/
const HEADING_RE = /^ {0,3}#{1,6}\s/
const BLOCKQUOTE_RE = /^ {0,3}>/
const LIST_ITEM_PREFIX_RE = /^( {0,5}(?:[-*+]|\d{1,9}[.)]) +)/
const TABLE_RE = /^ {0,3}\|/
const HR_RE = /^ {0,3}([-*_])\s*(\1\s*){2,}$/
const INDENTED_CODE_RE = /^(?: {4}|\t)/

function segment(lines: SourceLine[], text: string): Segment[] {
  const segments: Segment[] = []
  let i = 0

  // YAML frontmatter: only at the very top of the file.
  if (lines.length > 0 && lines[0].text.trimEnd() === "---" && lines[0].start === 0) {
    let close = -1
    for (let j = 1; j < lines.length; j++) {
      const t = lines[j].text.trimEnd()
      if (t === "---" || t === "...") {
        close = j
        break
      }
    }
    if (close !== -1) {
      for (let j = 0; j <= close; j++) segments.push({ type: "verbatim", line: lines[j] })
      i = close + 1
    }
  }

  let paragraph: SourceLine[] = []
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      segments.push({ type: "paragraph", lines: paragraph })
      paragraph = []
    }
  }

  let inFence: string | null = null
  let inMathBlock = false
  let listDepth = false

  while (i < lines.length) {
    const line = lines[i]
    const t = line.text

    if (inMathBlock) {
      segments.push({ type: "verbatim", line })
      if (MATH_BLOCK_RE.test(t)) inMathBlock = false
      i++
      continue
    }

    if (inFence) {
      segments.push({ type: "verbatim", line })
      const m = FENCE_RE.exec(t)
      if (m && m[1][0] === inFence[0]) inFence = null
      i++
      continue
    }

    if (MATH_BLOCK_RE.test(t)) {
      flushParagraph()
      inMathBlock = true
      segments.push({ type: "verbatim", line })
      i++
      continue
    }

    const fenceMatch = FENCE_RE.exec(t)
    if (fenceMatch) {
      flushParagraph()
      inFence = fenceMatch[1]
      segments.push({ type: "verbatim", line })
      i++
      continue
    }

    const blank = t.trim() === ""
    if (blank) {
      flushParagraph()
      listDepth = false
      segments.push({ type: "verbatim", line })
      i++
      continue
    }

    const structural =
      HEADING_RE.test(t) ||
      BLOCKQUOTE_RE.test(t) ||
      TABLE_RE.test(t) ||
      HR_RE.test(t.trimEnd()) ||
      INDENTED_CODE_RE.test(t)

    const listPrefixMatch = LIST_ITEM_PREFIX_RE.exec(t)
    if (listPrefixMatch) {
      listDepth = true
      flushParagraph()
      segments.push({ type: "list-item", line, markerWidth: listPrefixMatch[1].length })
      i++
      continue
    }

    if (structural || listDepth) {
      flushParagraph()
      segments.push({ type: "verbatim", line })
      i++
      continue
    }

    paragraph.push(line)
    i++
  }
  flushParagraph()
  return segments
}

class ProjectionBuilder {
  private tokens: ProjectedToken[] = []
  private lines: ProjectedLine[] = []
  private projectedParts: string[] = []
  private projOffset = 0

  // Accumulator for the line being built.
  private lineStartProj = 0
  private lineParts: string[] = []
  private lineSrcStart: number | null = null
  private lineSrcEnd: number | null = null
  private lineKind: ProjectedLineKind = "blank"

  constructor(private filePath: string, private originalText: string) {}

  private pushToken(tok: ProjectedToken): void {
    this.tokens.push(tok)
    this.projectedParts.push(tok.text)
    this.projOffset += tok.text.length
  }

  private addContent(tok: ProjectedToken, kind: ProjectedLineKind): void {
    this.pushToken(tok)
    this.lineParts.push(tok.text)
    if (tok.sourceSpan) {
      if (this.lineSrcStart === null) this.lineSrcStart = tok.sourceSpan.startOffset
      this.lineSrcEnd = tok.sourceSpan.endOffset
    }
    if (this.lineKind === "blank") this.lineKind = kind
  }

  /**
   * Ends the current projected line. Real newlines carry the span of the
   * newline character (`newlineSrcPos`); synthetic ones carry null.
   * `srcPosFallback` anchors blank lines.
   */
  private endLine(
    synthetic: boolean,
    srcPosFallback: number | null,
    newlineSrcPos: number | null = null
  ): void {
    const text = this.lineParts.join("")
    const projEnd = this.projOffset
    this.pushToken({
      text: "\n",
      sourceSpan:
        !synthetic && newlineSrcPos !== null
          ? { startOffset: newlineSrcPos, endOffset: newlineSrcPos + 1 }
          : null,
      synthetic,
    })
    let sourceSpan = null
    if (this.lineSrcStart !== null && this.lineSrcEnd !== null) {
      sourceSpan = { startOffset: this.lineSrcStart, endOffset: this.lineSrcEnd }
    } else if (srcPosFallback !== null) {
      sourceSpan = { startOffset: srcPosFallback, endOffset: srcPosFallback }
    }
    this.lines.push({
      text,
      projStart: this.lineStartProj,
      projEnd,
      sourceSpan,
      syntheticEol: synthetic,
      kind: text.length === 0 ? "blank" : this.lineKind,
    })
    this.lineStartProj = this.projOffset
    this.lineParts = []
    this.lineSrcStart = null
    this.lineSrcEnd = null
    this.lineKind = "blank"
  }

  emitVerbatimLine(line: SourceLine): void {
    if (line.text.length > 0) {
      this.addContent(
        {
          text: line.text,
          sourceSpan: { startOffset: line.start, endOffset: line.end },
          synthetic: false,
        },
        "verbatim"
      )
    }
    if (line.newlineAt !== -1) {
      this.endLine(false, line.start, line.newlineAt)
    } else if (line.text.length > 0) {
      this.finishTrailingLine(line.start)
    }
  }

  /**
   * Splits a list item's content into clauses. The first clause keeps the
   * list marker prefix (`- `, `1. `, etc.); continuation clauses are indented
   * by the same width with synthetic spaces so they visually align below the
   * content — making it obvious the clauses belong to one list item.
   * Falls back to verbatim when there's only one clause.
   */
  emitListItem(line: SourceLine, markerWidth: number, conjunctionMinLength: number): void {
    const contentStart = line.start + markerWidth
    const contentEnd = line.end

    if (contentEnd <= contentStart) {
      this.emitVerbatimLine(line)
      return
    }

    const clauses = splitClauses(this.originalText.slice(contentStart, contentEnd), conjunctionMinLength)
    if (clauses.length <= 1) {
      this.emitVerbatimLine(line)
      return
    }

    // Emit the marker as a real token, then reset lineKind so the subsequent
    // clause content classifies the line as "prose" (not "verbatim").
    this.addContent(
      {
        text: this.originalText.slice(line.start, contentStart),
        sourceSpan: { startOffset: line.start, endOffset: contentStart },
        synthetic: false,
      },
      "verbatim"
    )
    this.lineKind = "blank"

    const indent = " ".repeat(markerWidth)

    for (let c = 0; c < clauses.length; c++) {
      const clause = clauses[c]
      const absStart = contentStart + clause.start
      const absEnd = contentStart + clause.end

      this.emitClauseContent(absStart, absEnd)

      const isLast = c === clauses.length - 1
      if (!isLast) {
        this.endLine(true, null)
        // Synthetic indent aligns continuation clauses under the content.
        this.addContent({ text: indent, sourceSpan: null, synthetic: true }, "prose")
      }
    }

    if (line.newlineAt !== -1) {
      this.endLine(false, line.start, line.newlineAt)
    } else {
      this.finishTrailingLine(line.start)
    }
  }

  emitParagraph(paraLines: SourceLine[], conjunctionMinLength: number): void {
    const pStart = paraLines[0].start
    const last = paraLines[paraLines.length - 1]
    const pEnd = last.end
    const paraText = this.originalText.slice(pStart, pEnd)
    const clauses = splitClauses(paraText, conjunctionMinLength)

    for (let c = 0; c < clauses.length; c++) {
      const clause = clauses[c]
      const absStart = pStart + clause.start
      const absEnd = pStart + clause.end
      this.emitClauseContent(absStart, absEnd)
      const isLastClause = c === clauses.length - 1
      if (!isLastClause) {
        // Synthetic break between clauses; the source whitespace separating
        // them is consumed (not represented in the projection).
        this.endLine(true, null)
      }
    }

    if (last.newlineAt !== -1) {
      this.endLine(false, pStart, last.newlineAt)
    } else if (clauses.length > 0) {
      this.finishTrailingLine(pStart)
    }
  }

  /**
   * Emits one clause's content. Hard wraps inside the clause become
   * replacement tokens: projected " ", source span covering the whitespace
   * run around the newline.
   */
  private emitClauseContent(absStart: number, absEnd: number): void {
    const text = this.originalText
    let i = absStart
    let runStart = absStart
    while (i < absEnd) {
      if (text[i] === "\n") {
        let wsStart = i
        while (wsStart > runStart && (text[wsStart - 1] === " " || text[wsStart - 1] === "\t")) {
          wsStart--
        }
        if (wsStart > runStart) {
          this.addContent(
            {
              text: text.slice(runStart, wsStart),
              sourceSpan: { startOffset: runStart, endOffset: wsStart },
              synthetic: false,
            },
            "prose"
          )
        }
        let wsEnd = i + 1
        while (wsEnd < absEnd && (text[wsEnd] === " " || text[wsEnd] === "\t")) wsEnd++
        this.addContent(
          {
            text: " ",
            sourceSpan: { startOffset: wsStart, endOffset: wsEnd },
            synthetic: false,
          },
          "prose"
        )
        i = wsEnd
        runStart = wsEnd
      } else {
        i++
      }
    }
    if (runStart < absEnd) {
      this.addContent(
        {
          text: text.slice(runStart, absEnd),
          sourceSpan: { startOffset: runStart, endOffset: absEnd },
          synthetic: false,
        },
        "prose"
      )
    }
  }

  /** Closes the final line of a file that has no trailing newline. */
  private finishTrailingLine(srcPosFallback: number): void {
    const text = this.lineParts.join("")
    let sourceSpan = null
    if (this.lineSrcStart !== null && this.lineSrcEnd !== null) {
      sourceSpan = { startOffset: this.lineSrcStart, endOffset: this.lineSrcEnd }
    } else {
      sourceSpan = { startOffset: srcPosFallback, endOffset: srcPosFallback }
    }
    this.lines.push({
      text,
      projStart: this.lineStartProj,
      projEnd: this.projOffset,
      sourceSpan,
      syntheticEol: false,
      kind: text.length === 0 ? "blank" : this.lineKind,
    })
    this.lineStartProj = this.projOffset
    this.lineParts = []
    this.lineSrcStart = null
    this.lineSrcEnd = null
    this.lineKind = "blank"
  }

  finish(): Projection {
    if (this.lineParts.length > 0) {
      this.finishTrailingLine(this.originalText.length)
    }
    return {
      filePath: this.filePath,
      originalText: this.originalText,
      projectedText: this.projectedParts.join(""),
      tokens: this.tokens,
      lines: this.lines,
    }
  }
}
