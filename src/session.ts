import { AnnotatedChange } from "./types/diff"
import { Projection } from "./types/projection"
import { RepoContext } from "./types/git"
import { projectDocument } from "./projection/projectDocument"
import { analyze } from "./diff/hunkMapping"
import { ClauseDiffOptions } from "./diff/clauseDiff"
import { buildAlignedDocuments, AlignedDocuments } from "./diff/alignment"

export type ChangeStatus = "pending" | "ignored"

export type SessionChange = AnnotatedChange & { status: ChangeStatus }

export type SessionMode =
  /** index vs working tree — changes are stageable */
  | { kind: "working" }
  /** two historical refs — read-only, no staging */
  | { kind: "historical"; oldRef: string; newRef: string }

/**
 * One semantic-diff session for a file. Supports two modes:
 *  - working: index blob vs working tree (stageable)
 *  - historical: any two git refs (read-only review)
 */
export class Session {
  projectionEnabled = true
  oldText = ""
  newText = ""
  /** True when the file is untracked (no index blob). Only relevant in working mode. */
  isNew = false
  oldProjection!: Projection
  newProjection!: Projection
  aligned!: AlignedDocuments
  changes: SessionChange[] = []
  private ignoredIds = new Set<string>()
  private splitMoveIds = new Set<string>()

  constructor(
    public readonly filePath: string,
    public readonly repo: RepoContext,
    private conjunctionMinLength: number,
    public readonly mode: SessionMode = { kind: "working" },
    private diffOpts: ClauseDiffOptions = {}
  ) {}

  get isReadOnly(): boolean {
    return this.mode.kind === "historical"
  }

  rebuild(oldText: string | null, newText: string): void {
    this.isNew = oldText === null && this.mode.kind === "working"
    this.oldText = oldText ?? ""
    this.newText = newText
    const opts = {
      enabled: this.projectionEnabled,
      conjunctionMinLength: this.conjunctionMinLength,
    }
    this.oldProjection = projectDocument(this.filePath, this.oldText, opts)
    this.newProjection = projectDocument(this.filePath, this.newText, opts)
    const annotated = this.projectionEnabled ? analyze(this.oldProjection, this.newProjection, this.diffOpts) : []
    this.changes = annotated.map((a) => ({
      ...a,
      status: this.ignoredIds.has(a.change.id) ? "ignored" : "pending",
    }))
    this.aligned = buildAlignedDocuments(this.oldProjection, this.newProjection, annotated)
  }

  setIgnored(changeId: string, ignored: boolean): void {
    if (ignored) this.ignoredIds.add(changeId)
    else this.ignoredIds.delete(changeId)
    for (const c of this.changes) {
      if (c.change.id === changeId) c.status = ignored ? "ignored" : "pending"
    }
  }

  findChange(changeId: string): SessionChange | undefined {
    return this.changes.find((c) => c.change.id === changeId)
  }

  findChangesForMove(moveId: string): [SessionChange, SessionChange] | null {
    const pair = this.changes.filter((c) => c.change.moveId === moveId)
    if (pair.length !== 2) return null
    return [pair[0], pair[1]]
  }

  isMoveActive(moveId: string): boolean {
    return !this.splitMoveIds.has(moveId)
  }

  splitMove(moveId: string): void {
    this.splitMoveIds.add(moveId)
  }

  ignoreBothInMove(moveId: string, ignored: boolean): void {
    for (const c of this.changes) {
      if (c.change.moveId === moveId) this.setIgnored(c.change.id, ignored)
    }
  }

  /** Changes that can be staged right now: stageable and not ignored. */
  stageableChanges(): SessionChange[] {
    if (this.isReadOnly) return []
    return this.changes.filter(
      (c) => c.status === "pending" && c.stageability.kind === "stageable"
    )
  }
}
