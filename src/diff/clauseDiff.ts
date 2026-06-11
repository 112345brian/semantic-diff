import { ClauseChange } from "../types/diff"
import { ProjectedLine } from "../types/projection"

export interface ClauseDiffOptions {
  /**
   * When true, changes to ordered-list sequence numbers are not treated as
   * meaningful differences. "1. item" and "3. item" compare equal; only the
   * item text matters.
   */
  ignoreListNumbering?: boolean
}

/** Normalizes an ordered-list number to a placeholder for comparison. */
function normalizeListNumber(text: string, ignore: boolean): string {
  if (!ignore) return text
  // Matches "1. " / "10. " / "1) " / "10) " at the start of a line.
  return text.replace(/^\d+([.)]) /, "N$1 ")
}

export type LineOp =
  | { type: "equal"; oldIndex: number; newIndex: number }
  | { type: "delete"; oldIndex: number }
  | { type: "insert"; newIndex: number }

/**
 * Line diff via LCS with common prefix/suffix trimming. Inputs are projected
 * lines, so "line" here means "clause" for prose.
 */
export function diffLines(oldLines: string[], newLines: string[]): LineOp[] {
  let prefix = 0
  const maxPrefix = Math.min(oldLines.length, newLines.length)
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix++

  let suffix = 0
  while (
    suffix < Math.min(oldLines.length, newLines.length) - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++
  }

  const a = oldLines.slice(prefix, oldLines.length - suffix)
  const b = newLines.slice(prefix, newLines.length - suffix)

  const ops: LineOp[] = []
  for (let i = 0; i < prefix; i++) ops.push({ type: "equal", oldIndex: i, newIndex: i })

  // LCS dynamic program over the trimmed middle.
  const n = a.length
  const m = b.length
  if (n > 0 || m > 0) {
    const dp: Uint32Array[] = []
    for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push({ type: "equal", oldIndex: prefix + i, newIndex: prefix + j })
        i++
        j++
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ type: "delete", oldIndex: prefix + i })
        i++
      } else {
        ops.push({ type: "insert", newIndex: prefix + j })
        j++
      }
    }
    while (i < n) {
      ops.push({ type: "delete", oldIndex: prefix + i })
      i++
    }
    while (j < m) {
      ops.push({ type: "insert", newIndex: prefix + j })
      j++
    }
  }

  for (let k = 0; k < suffix; k++) {
    ops.push({
      type: "equal",
      oldIndex: oldLines.length - suffix + k,
      newIndex: newLines.length - suffix + k,
    })
  }
  return ops
}

/**
 * Converts diff ops into stageable clause changes.
 *
 * Within one contiguous run of non-equal ops:
 *  - equal counts of deletes and inserts pair positionally into independent
 *    per-clause modifications;
 *  - unequal but nonzero counts collapse into one grouped modification (the
 *    typical cause is a clause-boundary shift, where partial staging would
 *    drop text);
 *  - pure inserts / pure deletes become independent per-clause changes.
 */
export function computeClauseChanges(
  oldLines: ProjectedLine[],
  newLines: ProjectedLine[],
  opts: ClauseDiffOptions = {}
): ClauseChange[] {
  const ignoreNum = opts.ignoreListNumbering ?? false
  const ops = diffLines(
    oldLines.map((l) => normalizeListNumber(l.text, ignoreNum)),
    newLines.map((l) => normalizeListNumber(l.text, ignoreNum))
  )

  const changes: ClauseChange[] = []
  let lastOld = -1
  let lastNew = -1
  let i = 0
  while (i < ops.length) {
    const op = ops[i]
    if (op.type === "equal") {
      lastOld = op.oldIndex
      lastNew = op.newIndex
      i++
      continue
    }
    const dels: number[] = []
    const ins: number[] = []
    while (i < ops.length && ops[i].type !== "equal") {
      const o = ops[i]
      if (o.type === "delete") dels.push(o.oldIndex)
      else if (o.type === "insert") ins.push(o.newIndex)
      i++
    }
    const anchorOld = lastOld
    const anchorNew = lastNew

    if (dels.length > 0 && ins.length > 0) {
      if (dels.length === ins.length) {
        for (let k = 0; k < dels.length; k++) {
          changes.push(makeChange("modified", false, dels[k], dels[k], ins[k], ins[k], anchorOld, anchorNew))
        }
      } else {
        changes.push(
          makeChange(
            "modified",
            true,
            dels[0],
            dels[dels.length - 1],
            ins[0],
            ins[ins.length - 1],
            anchorOld,
            anchorNew
          )
        )
      }
    } else if (ins.length > 0) {
      for (const [s, e] of groupWithBlanks(ins, (i) => newLines[i].kind === "blank")) {
        changes.push(makeChange("inserted", e > s, null, null, s, e, anchorOld, anchorNew))
      }
    } else {
      for (const [s, e] of groupWithBlanks(dels, (i) => oldLines[i].kind === "blank")) {
        changes.push(makeChange("deleted", e > s, s, e, null, null, anchorOld, anchorNew))
      }
    }
    if (dels.length > 0) lastOld = dels[dels.length - 1]
    if (ins.length > 0) lastNew = ins[ins.length - 1]
  }
  return changes
}

/**
 * Splits a consecutive index run into stageable groups: each non-blank line
 * is its own group, and blank lines (paragraph separators) attach to the
 * nearest adjacent group — a deleted paragraph travels with its blank line
 * instead of becoming a stray newline change.
 */
function groupWithBlanks(
  indices: number[],
  isBlank: (idx: number) => boolean
): Array<[number, number]> {
  const groups: Array<[number, number]> = []
  let pendingBlankStart: number | null = null
  for (const idx of indices) {
    if (isBlank(idx)) {
      if (groups.length > 0 && groups[groups.length - 1][1] === idx - 1) {
        groups[groups.length - 1][1] = idx
      } else if (pendingBlankStart === null) {
        pendingBlankStart = idx
      }
      continue
    }
    const start = pendingBlankStart !== null ? pendingBlankStart : idx
    pendingBlankStart = null
    groups.push([start, idx])
  }
  if (pendingBlankStart !== null) {
    // Blank-only run (a paragraph split or join).
    groups.push([pendingBlankStart, indices[indices.length - 1]])
  }
  return groups
}

function makeChange(
  kind: ClauseChange["kind"],
  grouped: boolean,
  oldStartIndex: number | null,
  oldEndIndex: number | null,
  newStartIndex: number | null,
  newEndIndex: number | null,
  anchorOldIndex: number,
  anchorNewIndex: number
): ClauseChange {
  return {
    id: `${kind}:${oldStartIndex ?? "-"}:${oldEndIndex ?? "-"}:${newStartIndex ?? "-"}:${newEndIndex ?? "-"}`,
    kind,
    grouped,
    oldStartIndex,
    oldEndIndex,
    newStartIndex,
    newEndIndex,
    anchorOldIndex,
    anchorNewIndex,
  }
}
