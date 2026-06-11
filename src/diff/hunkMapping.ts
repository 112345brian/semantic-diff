import { AnnotatedChange, ClauseChange, SourceEdit, Stageability } from "../types/diff"
import { Projection, ProjectedLine } from "../types/projection"
import { computeClauseChanges, ClauseDiffOptions } from "./clauseDiff"

/**
 * Full analysis pipeline: clause diff + stageability + move detection.
 */
export function analyze(
  oldProj: Projection,
  newProj: Projection,
  opts: ClauseDiffOptions = {}
): AnnotatedChange[] {
  const changes = computeClauseChanges(oldProj.lines, newProj.lines, opts)
  const annotated = changes.map((change) => ({
    change,
    stageability: computeStageability(change, oldProj, newProj),
  }))
  detectMoves(annotated, oldProj, newProj)
  return annotated
}

const MOVE_SIMILARITY_THRESHOLD = 0.85
const MOVE_MIN_CHARS = 20

function detectMoves(
  annotated: AnnotatedChange[],
  oldProj: Projection,
  newProj: Projection
): void {
  const deletions = annotated.filter(
    (a) => a.change.kind === "deleted" && a.stageability.kind === "stageable"
  )
  const insertions = annotated.filter(
    (a) => a.change.kind === "inserted" && a.stageability.kind === "stageable"
  )

  const delTexts = deletions.map((a) =>
    blockText(oldProj.lines, a.change.oldStartIndex, a.change.oldEndIndex)
  )
  const insTexts = insertions.map((a) =>
    blockText(newProj.lines, a.change.newStartIndex, a.change.newEndIndex)
  )

  const usedIns = new Set<number>()
  for (let di = 0; di < deletions.length; di++) {
    const dt = delTexts[di]
    if (dt.length < MOVE_MIN_CHARS) continue
    let bestSim = MOVE_SIMILARITY_THRESHOLD
    let bestIi = -1
    for (let ii = 0; ii < insertions.length; ii++) {
      if (usedIns.has(ii)) continue
      const it = insTexts[ii]
      if (it.length < MOVE_MIN_CHARS) continue
      const sim = moveBigramSimilarity(dt, it)
      if (sim > bestSim) { bestSim = sim; bestIi = ii }
    }
    if (bestIi >= 0) {
      const moveId = `move:${deletions[di].change.id}:${insertions[bestIi].change.id}`
      deletions[di].change.moveId = moveId
      insertions[bestIi].change.moveId = moveId
      usedIns.add(bestIi)
    }
  }
}

function blockText(
  lines: ProjectedLine[],
  startIdx: number | null,
  endIdx: number | null
): string {
  if (startIdx === null || endIdx === null) return ""
  return lines
    .slice(startIdx, endIdx + 1)
    .filter((l) => l.kind !== "blank")
    .map((l) => l.text)
    .join(" ")
}

function moveBigramSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const toSet = (s: string) => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const sa = toSet(a)
  const sb = toSet(b)
  let overlap = 0
  for (const bg of sa) if (sb.has(bg)) overlap++
  return (2 * overlap) / (sa.size + sb.size)
}

/**
 * Determines whether a clause change maps cleanly back to the real files and,
 * if so, what concrete edit against the old (index-side) text it implies.
 *
 * The replacement text is always sliced from the *real* working file — never
 * from the projection — so staging can never write projected artifacts
 * (normalized whitespace, synthetic breaks) into the repository.
 */
export function computeStageability(
  change: ClauseChange,
  oldProj: Projection,
  newProj: Projection
): Stageability {
  const oldText = oldProj.originalText
  const newText = newProj.originalText
  const oldLines = oldProj.lines
  const newLines = newProj.lines

  switch (change.kind) {
    case "modified": {
      const oldSpan = rangeSpan(oldLines, change.oldStartIndex!, change.oldEndIndex!)
      const newSpan = rangeSpan(newLines, change.newStartIndex!, change.newEndIndex!)
      if (!oldSpan) return unsafe("the old clause does not map to real source text")
      if (!newSpan) return unsafe("the new clause does not map to real source text")
      const replacement = newText.slice(newSpan.start, newSpan.end)
      const oldSlice = oldText.slice(oldSpan.start, oldSpan.end)
      if (oldSlice === replacement) {
        return unsafe("only the projection changed (clause break shift); the file text is identical")
      }
      return stageable({ oldStart: oldSpan.start, oldEnd: oldSpan.end, newText: replacement })
    }

    case "inserted": {
      const newSpan = rangeSpan(newLines, change.newStartIndex!, change.newEndIndex!)
      if (!newSpan) return unsafe("the inserted clause does not map to real source text")

      // Groups containing blank lines (inserted paragraphs, paragraph
      // splits) replace the whole gap between the surrounding anchors with
      // the corresponding gap from the working file, so separators are
      // mirrored exactly rather than reconstructed.
      if (containsBlank(newLines, change.newStartIndex!, change.newEndIndex!)) {
        return gapReplacement(
          change.anchorOldIndex,
          change.newStartIndex! - 1,
          change.newEndIndex! + 1,
          oldProj,
          newProj
        )
      }
      const clauseText = newText.slice(newSpan.start, newSpan.end)

      if (change.anchorOldIndex >= 0) {
        const anchor = oldLines[change.anchorOldIndex]
        if (!anchor.sourceSpan) return unsafe("no stable source position to insert at")
        // The separator preceding the clause in the working file (a space,
        // a newline, a blank line...) is reproduced verbatim.
        const prevNew = change.newStartIndex! > 0 ? newLines[change.newStartIndex! - 1] : null
        const sepStart = prevNew?.sourceSpan ? prevNew.sourceSpan.endOffset : 0
        const separator = newText.slice(sepStart, newSpan.start)
        const insertPos = anchor.sourceSpan.endOffset
        return stageable({ oldStart: insertPos, oldEnd: insertPos, newText: separator + clauseText })
      }

      // Insertion at the top of the file: take the separator that follows
      // the clause instead.
      const nextNew =
        change.newEndIndex! + 1 < newLines.length ? newLines[change.newEndIndex! + 1] : null
      const sepEnd = nextNew?.sourceSpan ? nextNew.sourceSpan.startOffset : newText.length
      const separator = newText.slice(newSpan.end, sepEnd)
      return stageable({ oldStart: 0, oldEnd: 0, newText: clauseText + separator })
    }

    case "deleted": {
      const oldSpan = rangeSpan(oldLines, change.oldStartIndex!, change.oldEndIndex!)
      if (!oldSpan) return unsafe("the deleted clause does not map to real source text")

      if (containsBlank(oldLines, change.oldStartIndex!, change.oldEndIndex!)) {
        return gapDeletion(
          change.oldStartIndex! - 1,
          change.oldEndIndex! + 1,
          change.anchorNewIndex,
          oldProj,
          newProj
        )
      }
      const del = deletionRange(oldLines, change.oldStartIndex!, change.oldEndIndex!, oldText)
      if (!del) return unsafe("no stable source range to delete")
      return stageable({ oldStart: del.start, oldEnd: del.end, newText: "" })
    }
  }
}

function rangeSpan(
  lines: ProjectedLine[],
  startIdx: number,
  endIdx: number
): { start: number; end: number } | null {
  const first = lines[startIdx]
  const last = lines[endIdx]
  if (!first?.sourceSpan || !last?.sourceSpan) return null
  // Every line in the range must map; otherwise the slice between first and
  // last could include content we cannot account for.
  for (let i = startIdx; i <= endIdx; i++) {
    if (!lines[i]?.sourceSpan) return null
  }
  const start = first.sourceSpan.startOffset
  const end = last.sourceSpan.endOffset
  if (end < start) return null
  return { start, end }
}

/**
 * Computes the source range to remove for a deleted clause, including the
 * separator that joined it to its neighbors.
 *
 * Mid-paragraph deletions consume the separator before the clause. A clause
 * that is an entire paragraph also swallows one adjacent blank line so the
 * deletion does not leave a doubled paragraph break behind.
 */
function deletionRange(
  oldLines: ProjectedLine[],
  startIdx: number,
  endIdx: number,
  oldText: string
): { start: number; end: number } | null {
  const span = rangeSpan(oldLines, startIdx, endIdx)
  if (!span) return null

  const prev = startIdx > 0 ? oldLines[startIdx - 1] : null
  const next = endIdx + 1 < oldLines.length ? oldLines[endIdx + 1] : null

  const prevBlank = prev !== null && prev.kind === "blank"
  const nextBlank = next === null || next.kind === "blank"

  if (prev === null) {
    // Top of file: delete forward through the following separator.
    const end = next?.sourceSpan ? next.sourceSpan.startOffset : oldText.length
    return { start: 0, end: Math.max(end, span.end) }
  }
  if (!prev.sourceSpan) return null

  if (prevBlank && nextBlank) {
    // Whole-paragraph deletion: also remove the preceding blank line so we
    // don't leave two consecutive paragraph breaks.
    const beforeBlank = startIdx - 2 >= 0 ? oldLines[startIdx - 2] : null
    const start = beforeBlank?.sourceSpan ? beforeBlank.sourceSpan.endOffset : 0
    return { start, end: span.end }
  }

  // Mid-paragraph (or mid-list) deletion: remove the preceding separator and
  // the clause itself.
  return { start: prev.sourceSpan.endOffset, end: span.end }
}

function containsBlank(lines: ProjectedLine[], startIdx: number, endIdx: number): boolean {
  for (let i = startIdx; i <= endIdx; i++) {
    if (lines[i]?.kind === "blank") return true
  }
  return false
}

/**
 * Replaces the old text between two surviving anchor lines with the
 * corresponding region of the working file. Used for insertions involving
 * paragraph separators, where mirroring the working file's whitespace is the
 * only way to get separators exactly right.
 */
function gapReplacement(
  anchorOldIndex: number,
  prevNewIndex: number,
  nextNewIndex: number,
  oldProj: Projection,
  newProj: Projection
): Stageability {
  const oldLines = oldProj.lines
  const newLines = newProj.lines

  const oldStart =
    anchorOldIndex >= 0 ? oldLines[anchorOldIndex]?.sourceSpan?.endOffset : 0
  const nextOld = oldLines[anchorOldIndex + 1]
  const oldEnd =
    anchorOldIndex + 1 < oldLines.length
      ? nextOld?.sourceSpan?.startOffset
      : oldProj.originalText.length
  const newFrom = prevNewIndex >= 0 ? newLines[prevNewIndex]?.sourceSpan?.endOffset : 0
  const newTo =
    nextNewIndex < newLines.length
      ? newLines[nextNewIndex]?.sourceSpan?.startOffset
      : newProj.originalText.length

  if (oldStart === undefined || oldEnd === undefined || newFrom === undefined || newTo === undefined) {
    return unsafe("the surrounding text does not map to stable source positions")
  }
  return stageable({
    oldStart,
    oldEnd,
    newText: newProj.originalText.slice(newFrom, newTo),
  })
}

/**
 * Deletes the old text between the lines surrounding a deleted group,
 * replacing it with the corresponding (smaller) gap from the working file.
 */
function gapDeletion(
  prevOldIndex: number,
  nextOldIndex: number,
  anchorNewIndex: number,
  oldProj: Projection,
  newProj: Projection
): Stageability {
  const oldLines = oldProj.lines
  const newLines = newProj.lines

  const oldStart = prevOldIndex >= 0 ? oldLines[prevOldIndex]?.sourceSpan?.endOffset : 0
  const oldEnd =
    nextOldIndex < oldLines.length
      ? oldLines[nextOldIndex]?.sourceSpan?.startOffset
      : oldProj.originalText.length
  const newFrom = anchorNewIndex >= 0 ? newLines[anchorNewIndex]?.sourceSpan?.endOffset : 0
  const newTo =
    anchorNewIndex + 1 < newLines.length
      ? newLines[anchorNewIndex + 1]?.sourceSpan?.startOffset
      : newProj.originalText.length

  if (oldStart === undefined || oldEnd === undefined || newFrom === undefined || newTo === undefined) {
    return unsafe("the surrounding text does not map to stable source positions")
  }
  return stageable({
    oldStart,
    oldEnd,
    newText: newProj.originalText.slice(newFrom, newTo),
  })
}

function unsafe(reason: string): Stageability {
  return { kind: "unsafe", reason }
}

function stageable(edit: SourceEdit): Stageability {
  return { kind: "stageable", edit }
}
