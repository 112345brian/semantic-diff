import { AnnotatedChange } from "../types/diff"
import { Projection } from "../types/projection"

export type AlignedDocuments = {
  oldText: string
  newText: string
  /** Maps change id → line index in the aligned documents (for CodeLens). */
  changeLineMap: Map<string, number>
  /** Aligned-document line indices that carry a synthetic clause-break marker. */
  syntheticBreakLinesOld: Set<number>
  syntheticBreakLinesNew: Set<number>
}

/**
 * Produces two virtual document texts where modified clause pairs are kept on
 * the same line index so VS Code's diff editor can do intra-line word
 * highlighting. Insertions pad the old side with blank lines; deletions pad
 * the new side; grouped changes (unequal counts) use similarity-based pairing
 * to maximise the chance that related clauses land on the same line.
 */
export function buildAlignedDocuments(
  oldProj: Projection,
  newProj: Projection,
  changes: AnnotatedChange[]
): AlignedDocuments {
  const oldLines = oldProj.lines.map((l) => l.text)
  const newLines = newProj.lines.map((l) => l.text)
  const oldSynth = oldProj.lines.map((l) => l.syntheticEol)
  const newSynth = newProj.lines.map((l) => l.syntheticEol)

  const outOld: string[] = []
  const outNew: string[] = []
  const syntheticBreakLinesOld = new Set<number>()
  const syntheticBreakLinesNew = new Set<number>()
  const changeLineMap = new Map<string, number>()

  const pushOld = (projIdx: number | null) => {
    const idx = outOld.length
    outOld.push(projIdx !== null ? (oldLines[projIdx] ?? "") : "")
    if (projIdx !== null && oldSynth[projIdx]) syntheticBreakLinesOld.add(idx)
  }
  const pushNew = (projIdx: number | null) => {
    const idx = outNew.length
    outNew.push(projIdx !== null ? (newLines[projIdx] ?? "") : "")
    if (projIdx !== null && newSynth[projIdx]) syntheticBreakLinesNew.add(idx)
  }

  let oldCursor = 0
  let newCursor = 0

  for (const { change } of changes) {
    // Equal lines before this change advance both cursors by the same amount.
    // For deletions (newStartIndex null) or insertions (oldStartIndex null),
    // derive the missing start from the equal-run length so the cursor isn't
    // reset to a position already emitted.
    const equalCount = (change.oldStartIndex ?? oldCursor) - oldCursor
    const oldStart = oldCursor + equalCount
    const newStart = change.newStartIndex ?? (newCursor + equalCount)

    for (let i = 0; i < equalCount; i++) {
      pushOld(oldCursor + i)
      pushNew(newCursor + i)
    }
    oldCursor = oldStart
    newCursor = newStart

    const oldCount =
      change.oldStartIndex !== null ? change.oldEndIndex! - change.oldStartIndex! + 1 : 0
    const newCount =
      change.newStartIndex !== null ? change.newEndIndex! - change.newStartIndex! + 1 : 0

    changeLineMap.set(change.id, outOld.length)

    if (oldCount === 0) {
      for (let i = 0; i < newCount; i++) {
        pushOld(null)
        pushNew(change.newStartIndex! + i)
      }
    } else if (newCount === 0) {
      for (let i = 0; i < oldCount; i++) {
        pushOld(change.oldStartIndex! + i)
        pushNew(null)
      }
    } else if (oldCount === newCount) {
      for (let i = 0; i < oldCount; i++) {
        pushOld(change.oldStartIndex! + i)
        pushNew(change.newStartIndex! + i)
      }
    } else {
      // Grouped change: pair by bigram similarity, pad the shorter side.
      const oldIndices = Array.from({ length: oldCount }, (_, i) => change.oldStartIndex! + i)
      const newIndices = Array.from({ length: newCount }, (_, i) => change.newStartIndex! + i)
      const oldTexts = oldIndices.map((i) => oldLines[i] ?? "")
      const newTexts = newIndices.map((i) => newLines[i] ?? "")
      const block = alignGrouped(oldTexts, newTexts)
      // Recover original projection indices by matching text back to indices.
      const oldByText = new Map(oldIndices.map((i) => [oldLines[i], i]))
      const newByText = new Map(newIndices.map((i) => [newLines[i], i]))
      for (const [o, n] of block) {
        pushOld(o !== "" ? (oldByText.get(o) ?? null) : null)
        pushNew(n !== "" ? (newByText.get(n) ?? null) : null)
      }
    }

    oldCursor = change.oldStartIndex !== null ? change.oldEndIndex! + 1 : oldCursor
    newCursor = change.newStartIndex !== null ? change.newEndIndex! + 1 : newCursor
  }

  // Remaining equal tail.
  while (oldCursor < oldLines.length || newCursor < newLines.length) {
    pushOld(oldCursor < oldLines.length ? oldCursor++ : null)
    pushNew(newCursor < newLines.length ? newCursor++ : null)
  }

  // Preserve original trailing-newline behaviour.
  const join = (lines: string[], origEndsNl: boolean) => {
    if (lines.length === 0) return ""
    return lines.join("\n") + (origEndsNl ? "\n" : "")
  }
  const oldEndsNl = oldProj.originalText.endsWith("\n")
  const newEndsNl = newProj.originalText.endsWith("\n")

  return {
    oldText: join(outOld, oldEndsNl),
    newText: join(outNew, newEndsNl),
    changeLineMap,
    syntheticBreakLinesOld,
    syntheticBreakLinesNew,
  }
}

function alignGrouped(olds: string[], news: string[]): Array<[string, string]> {
  if (olds.length <= news.length) {
    return alignMinToMaj(olds, news)
  } else {
    return alignMinToMaj(news, olds).map(([a, b]) => [b, a])
  }
}

function alignMinToMaj(minor: string[], major: string[]): Array<[string, string]> {
  const assigned = new Map<number, string>()
  const unassigned: string[] = []

  for (const minLine of minor) {
    let bestIdx = 0
    let bestScore = -1
    for (let j = 0; j < major.length; j++) {
      const s = bigramSimilarity(minLine, major[j])
      if (s > bestScore) { bestScore = s; bestIdx = j }
    }
    if (assigned.has(bestIdx)) {
      unassigned.push(minLine)
    } else {
      assigned.set(bestIdx, minLine)
    }
  }

  const result: Array<[string, string]> = []
  for (let j = 0; j < major.length; j++) {
    const minLine = assigned.get(j)
    if (minLine !== undefined) {
      if (unassigned.length > 0) result.push([unassigned.shift()!, ""])
      result.push([minLine, major[j]])
    } else {
      result.push(["", major[j]])
    }
  }
  for (const u of unassigned) result.push([u, ""])
  return result
}

/** Dice coefficient on character bigrams — fast enough for clause-length strings. */
function bigramSimilarity(a: string, b: string): number {
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
