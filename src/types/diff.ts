export type ClauseChangeKind = "modified" | "inserted" | "deleted"

/**
 * One stageable unit of change at clause granularity.
 *
 * Most changes cover a single clause (start === end). When the diff cannot be
 * cleanly paired clause-for-clause — typically because an edit shifted clause
 * boundaries, producing an unequal number of old and new clauses — the whole
 * run is grouped into one change (`grouped: true`). Staging part of such a run
 * independently would silently drop text, so the group stages as one unit.
 */
export type ClauseChange = {
  id: string
  kind: ClauseChangeKind
  grouped: boolean
  /** Inclusive range of old-projection line indices. Null for insertions. */
  oldStartIndex: number | null
  oldEndIndex: number | null
  /** Inclusive range of new-projection line indices. Null for deletions. */
  newStartIndex: number | null
  newEndIndex: number | null
  /** Last old-projection line index before this change; -1 at top of file. */
  anchorOldIndex: number
  /** Last new-projection line index before this change; -1 at top of file. */
  anchorNewIndex: number
}

/** A concrete edit against the old (index-side) text. */
export type SourceEdit = {
  oldStart: number
  oldEnd: number
  newText: string
}

export type Stageability =
  | { kind: "stageable"; edit: SourceEdit }
  | { kind: "unsafe"; reason: string }

export type AnnotatedChange = {
  change: ClauseChange
  stageability: Stageability
}
