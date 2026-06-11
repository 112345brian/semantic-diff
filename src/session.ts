import { AnnotatedChange } from "./types/diff"
import { Projection } from "./types/projection"
import { RepoContext } from "./types/git"
import { projectDocument } from "./projection/projectDocument"
import { analyze } from "./diff/hunkMapping"

export type ChangeStatus = "pending" | "ignored"

export type SessionChange = AnnotatedChange & { status: ChangeStatus }

/**
 * One semantic-diff session per file: the index blob, the working text, both
 * projections, and the analyzed clause changes. Rebuilt whenever the file or
 * the index changes — staged clauses disappear naturally because the index
 * side catches up to them.
 */
export class Session {
  projectionEnabled = true
  oldText = ""
  newText = ""
  /** True when the file is untracked (no index blob). */
  isNew = false
  oldProjection!: Projection
  newProjection!: Projection
  changes: SessionChange[] = []
  private ignoredIds = new Set<string>()

  constructor(
    public readonly filePath: string,
    public readonly repo: RepoContext,
    private conjunctionMinLength: number
  ) {}

  rebuild(indexText: string | null, workingText: string): void {
    this.isNew = indexText === null
    this.oldText = indexText ?? ""
    this.newText = workingText
    const opts = {
      enabled: this.projectionEnabled,
      conjunctionMinLength: this.conjunctionMinLength,
    }
    this.oldProjection = projectDocument(this.filePath, this.oldText, opts)
    this.newProjection = projectDocument(this.filePath, this.newText, opts)
    const annotated = this.projectionEnabled ? analyze(this.oldProjection, this.newProjection) : []
    this.changes = annotated.map((a) => ({
      ...a,
      status: this.ignoredIds.has(a.change.id) ? "ignored" : "pending",
    }))
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

  /** Changes that can be staged right now: stageable and not ignored. */
  stageableChanges(): SessionChange[] {
    return this.changes.filter(
      (c) => c.status === "pending" && c.stageability.kind === "stageable"
    )
  }
}
