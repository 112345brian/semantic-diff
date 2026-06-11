import { ProjectedToken, SourceSpan } from "../types/projection"

/**
 * Maps offsets in the projected text back to offsets in the original file
 * (and the reverse). Returning null is the primary safety gate: a range that
 * cannot be cleanly mapped must not be staged.
 */
export class SourceMap {
  /** Projected start offset of each token. */
  private starts: number[]
  private tokens: ProjectedToken[]

  constructor(tokens: ProjectedToken[]) {
    this.tokens = tokens
    this.starts = new Array(tokens.length)
    let off = 0
    for (let i = 0; i < tokens.length; i++) {
      this.starts[i] = off
      off += tokens[i].text.length
    }
  }

  private tokenIndexAt(projOffset: number): number {
    let lo = 0
    let hi = this.tokens.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const s = this.starts[mid]
      const e = s + this.tokens[mid].text.length
      if (projOffset < s) hi = mid - 1
      else if (projOffset >= e) lo = mid + 1
      else {
        found = mid
        break
      }
    }
    return found
  }

  projectedOffsetToSourceOffset(offset: number): number | null {
    const i = this.tokenIndexAt(offset)
    if (i === -1) return null
    const tok = this.tokens[i]
    if (tok.sourceSpan === null) return null
    const delta = offset - this.starts[i]
    const spanLen = tok.sourceSpan.endOffset - tok.sourceSpan.startOffset
    // Replacement tokens (e.g. " " standing in for "\n  ") may have differing
    // lengths; clamp into the span.
    return tok.sourceSpan.startOffset + Math.min(delta, spanLen)
  }

  /**
   * Maps a half-open projected range to a source span. Returns null when the
   * range starts or ends inside synthetic content.
   */
  projectedRangeToSourceRange(start: number, end: number): SourceSpan | null {
    if (end < start) return null
    if (start === end) {
      const s = this.projectedOffsetToSourceOffset(start)
      return s === null ? null : { startOffset: s, endOffset: s }
    }
    const s = this.projectedOffsetToSourceOffset(start)
    if (s === null) return null
    const lastIdx = this.tokenIndexAt(end - 1)
    if (lastIdx === -1) return null
    const lastTok = this.tokens[lastIdx]
    if (lastTok.sourceSpan === null) return null
    const delta = end - this.starts[lastIdx]
    const spanLen = lastTok.sourceSpan.endOffset - lastTok.sourceSpan.startOffset
    const e =
      delta >= lastTok.text.length
        ? lastTok.sourceSpan.endOffset
        : lastTok.sourceSpan.startOffset + Math.min(delta, spanLen)
    if (e < s) return null
    return { startOffset: s, endOffset: e }
  }

  /**
   * Best-effort reverse mapping: the smallest projected range whose tokens
   * cover the given source range. Source text not represented in the
   * projection (consumed separators) is absorbed into the nearest boundary.
   */
  sourceRangeToProjectedRange(start: number, end: number): { start: number; end: number } {
    let projStart = -1
    let projEnd = -1
    for (let i = 0; i < this.tokens.length; i++) {
      const span = this.tokens[i].sourceSpan
      if (!span) continue
      if (span.endOffset <= start) continue
      if (span.startOffset >= end && projStart !== -1) break
      const overlaps = span.startOffset < end && span.endOffset > start
      const touches = start === end && span.startOffset <= start && span.endOffset >= end
      if (!overlaps && !touches) continue
      const tokLen = this.tokens[i].text.length
      const spanLen = span.endOffset - span.startOffset
      const startDelta = Math.max(0, start - span.startOffset)
      const endDelta = Math.max(0, Math.min(end, span.endOffset) - span.startOffset)
      const sFactor = spanLen === 0 ? 0 : Math.min(startDelta, spanLen)
      const eFactor = spanLen === 0 ? 0 : Math.min(endDelta, spanLen)
      const tokProjStart = this.starts[i]
      const candStart = tokProjStart + Math.min(sFactor, tokLen)
      const candEnd = tokProjStart + Math.min(eFactor, tokLen)
      if (projStart === -1) projStart = candStart
      projEnd = Math.max(projEnd, candEnd)
    }
    if (projStart === -1) return { start: 0, end: 0 }
    return { start: projStart, end: Math.max(projStart, projEnd) }
  }
}
