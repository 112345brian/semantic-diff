import { SourceEdit } from "../types/diff"
import { diffLines } from "../diff/clauseDiff"

/**
 * Applies a set of non-overlapping edits to the old text. Insertions at the
 * same offset are applied in input order (earlier edits end up earlier in
 * the result).
 */
export function applyEdits(oldText: string, edits: SourceEdit[]): string {
  const indexed = edits.map((e, seq) => ({ ...e, seq }))
  indexed.sort((a, b) => a.oldStart - b.oldStart || a.seq - b.seq)
  for (let i = 1; i < indexed.length; i++) {
    if (indexed[i].oldStart < indexed[i - 1].oldEnd) {
      throw new Error("overlapping edits cannot be staged together")
    }
  }
  let result = oldText
  for (let i = indexed.length - 1; i >= 0; i--) {
    const e = indexed[i]
    if (e.oldStart < 0 || e.oldEnd > oldText.length || e.oldEnd < e.oldStart) {
      throw new Error("edit out of bounds")
    }
    result = result.slice(0, e.oldStart) + e.newText + result.slice(e.oldEnd)
  }
  return result
}

const CONTEXT = 3

type PatchLine = { prefix: " " | "-" | "+"; text: string; noNewline: boolean }

/**
 * Builds a git-applyable unified diff between oldText and newText for the
 * given repo-relative path. Returns null when the texts are identical.
 * `isNew` produces a new-file patch (untracked files).
 */
export function buildPatch(
  relPath: string,
  oldText: string,
  newText: string,
  opts: { isNew?: boolean } = {}
): string | null {
  if (oldText === newText) return null

  const oldLines = splitForDiff(oldText)
  const newLines = splitForDiff(newText)
  const oldEndsNl = oldText.length === 0 || oldText.endsWith("\n")
  const newEndsNl = newText.length === 0 || newText.endsWith("\n")

  let ops = diffLines(oldLines, newLines)

  // A change only to the trailing newline is invisible to the line diff:
  // force the last line into the patch as a delete+insert pair.
  if (oldEndsNl !== newEndsNl && oldLines.length > 0 && newLines.length > 0) {
    const last = ops[ops.length - 1]
    if (last?.type === "equal") {
      ops = ops.slice(0, -1)
      ops.push({ type: "delete", oldIndex: last.oldIndex })
      ops.push({ type: "insert", newIndex: last.newIndex })
    }
  }

  // Group ops into hunks with CONTEXT lines of context, merging hunks whose
  // context would overlap.
  type RawHunk = { startOp: number; endOp: number }
  const rawHunks: RawHunk[] = []
  let firstChange = -1
  let lastChange = -1
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== "equal") {
      if (firstChange === -1) firstChange = i
      lastChange = i
    } else if (firstChange !== -1 && i - lastChange > CONTEXT * 2) {
      rawHunks.push({ startOp: firstChange, endOp: lastChange })
      firstChange = -1
    }
  }
  if (firstChange !== -1) rawHunks.push({ startOp: firstChange, endOp: lastChange })
  if (rawHunks.length === 0) return null

  const header: string[] = [`diff --git a/${relPath} b/${relPath}`]
  if (opts.isNew) {
    header.push("new file mode 100644")
    header.push(`--- /dev/null`)
  } else {
    header.push(`--- a/${relPath}`)
  }
  header.push(`+++ b/${relPath}`)

  const body: string[] = []
  for (const hunk of rawHunks) {
    const startOp = Math.max(0, hunk.startOp - CONTEXT)
    const endOp = Math.min(ops.length - 1, hunk.endOp + CONTEXT)

    const lines: PatchLine[] = []
    let oldStart = -1
    let newStart = -1
    let oldCount = 0
    let newCount = 0

    for (let i = startOp; i <= endOp; i++) {
      const op = ops[i]
      if (op.type === "equal") {
        if (oldStart === -1) {
          oldStart = op.oldIndex
          newStart = op.newIndex
        }
        oldCount++
        newCount++
        lines.push({
          prefix: " ",
          text: oldLines[op.oldIndex],
          noNewline: op.oldIndex === oldLines.length - 1 && !oldEndsNl,
        })
      } else if (op.type === "delete") {
        if (oldStart === -1) {
          oldStart = op.oldIndex
          newStart = nextNewIndex(ops, i)
        }
        oldCount++
        lines.push({
          prefix: "-",
          text: oldLines[op.oldIndex],
          noNewline: op.oldIndex === oldLines.length - 1 && !oldEndsNl,
        })
      } else {
        if (oldStart === -1) {
          oldStart = nextOldIndex(ops, i)
          newStart = op.newIndex
        }
        newCount++
        lines.push({
          prefix: "+",
          text: newLines[op.newIndex],
          noNewline: op.newIndex === newLines.length - 1 && !newEndsNl,
        })
      }
    }

    // Unified diff line numbers are 1-based; a zero count uses the line
    // *before* the hunk position.
    const oldHeaderStart = oldCount === 0 ? oldStart : oldStart + 1
    const newHeaderStart = newCount === 0 ? newStart : newStart + 1
    body.push(`@@ -${oldHeaderStart},${oldCount} +${newHeaderStart},${newCount} @@`)
    for (const line of lines) {
      body.push(line.prefix + line.text)
      if (line.noNewline) body.push("\\ No newline at end of file")
    }
  }

  return header.concat(body).join("\n") + "\n"
}

function splitForDiff(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split("\n")
  if (text.endsWith("\n")) lines.pop()
  return lines
}

/** The old-file position an insertion at op index i lands at. */
function nextOldIndex(ops: ReturnType<typeof diffLines>, i: number): number {
  for (let j = i; j < ops.length; j++) {
    const op = ops[j]
    if (op.type === "equal" || op.type === "delete") return op.oldIndex
  }
  for (let j = i - 1; j >= 0; j--) {
    const op = ops[j]
    if (op.type === "equal" || op.type === "delete") return op.oldIndex + 1
  }
  return 0
}

function nextNewIndex(ops: ReturnType<typeof diffLines>, i: number): number {
  for (let j = i; j < ops.length; j++) {
    const op = ops[j]
    if (op.type === "equal" || op.type === "insert") return op.newIndex
  }
  for (let j = i - 1; j >= 0; j--) {
    const op = ops[j]
    if (op.type === "equal" || op.type === "insert") return op.newIndex + 1
  }
  return 0
}
