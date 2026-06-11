import * as path from "path"
import * as fs from "fs/promises"
import { Session, SessionChange } from "../session"
import { RepoContext } from "../types/git"
import { resolveRepo } from "../git/repository"
import { readIndexBlob } from "../git/blobReader"
import { applyEdits, buildPatch } from "../git/patchBuilder"
import { applyCachedPatch } from "../git/applyPatch"
import { SourceEdit } from "../types/diff"
import { BookProject } from "./detectProject"
import { ClauseDiffOptions } from "../diff/clauseDiff"

export type FileSlice = {
  filePath: string
  repo: RepoContext
  /** Start offset in the concatenated old text. */
  startOffset: number
  /** End offset in the concatenated old text (exclusive). */
  endOffset: number
  oldText: string
}

const FILE_SEPARATOR = "\n"

/**
 * A session over an entire bookdown/quarto project. Chapter files are
 * concatenated in render order; the semantic diff runs over the full book.
 * Staging maps source edits back to individual chapter files.
 */
export class BookSession {
  readonly rootDir: string
  readonly kind: "bookdown" | "quarto"
  projectionEnabled = true
  private inner!: Session
  slices: FileSlice[] = []

  constructor(
    readonly project: BookProject,
    private conjunctionMinLength: number,
    private diffOpts: ClauseDiffOptions = {}
  ) {
    this.rootDir = project.rootDir
    this.kind = project.kind
    // inner session uses rootDir as a virtual filePath; real file identity is
    // tracked in slices.
    this.inner = new Session(
      path.join(project.rootDir, "__BOOK__"),
      null as any,  // repo not used directly on inner session
      conjunctionMinLength,
      { kind: "historical", oldRef: "index", newRef: "working" },
      diffOpts
    )
  }

  /** Exposes the underlying Session for content/lens/decoration consumers. */
  get innerSession(): Session { return this.inner }

  get changes(): SessionChange[] { return this.inner.changes }
  get aligned() { return this.inner.aligned }
  get oldProjection() { return this.inner.oldProjection }
  get newProjection() { return this.inner.newProjection }
  get isReadOnly() { return false }

  isMoveActive(moveId: string) { return this.inner.isMoveActive(moveId) }
  splitMove(moveId: string) { return this.inner.splitMove(moveId) }
  findChange(id: string) { return this.inner.findChange(id) }
  findChangesForMove(moveId: string) { return this.inner.findChangesForMove(moveId) }
  setIgnored(id: string, v: boolean) { return this.inner.setIgnored(id, v) }
  ignoreBothInMove(moveId: string, v: boolean) { return this.inner.ignoreBothInMove(moveId, v) }
  stageableChanges() { return this.inner.stageableChanges() }

  async rebuild(workingTexts: Map<string, string>): Promise<void> {
    this.slices = []
    const oldParts: string[] = []
    const newParts: string[] = []
    let oldOffset = 0

    if (this.project.chapters.length === 0) return
    const baseRepo = await resolveRepo(this.project.chapters[0])
    if (!baseRepo) return

    for (const filePath of this.project.chapters) {
      const relPath = path.relative(baseRepo.repoRoot, filePath).split(path.sep).join("/")
      const repo: RepoContext = { repoRoot: baseRepo.repoRoot, relPath }

      const oldText = await readIndexBlob(repo) ?? ""
      const newText = workingTexts.get(filePath) ?? await readFileSafe(filePath)

      const sliceStart = oldOffset
      oldParts.push(oldText)
      newParts.push(newText)
      oldOffset += oldText.length + FILE_SEPARATOR.length

      this.slices.push({
        filePath,
        repo,
        startOffset: sliceStart,
        endOffset: sliceStart + oldText.length,
        oldText,
      })

      // Separator
      oldParts.push(FILE_SEPARATOR)
    }

    const oldConcat = oldParts.join("")
    const newConcat = newParts.join(FILE_SEPARATOR)
    // inner session uses historical mode so it accepts two explicit texts
    this.inner.rebuild(oldConcat, newConcat)
  }

  /** Resolve a source edit's global offset to the slice it lives in. */
  sliceFor(edit: SourceEdit): FileSlice | null {
    for (const s of this.slices) {
      if (edit.oldStart >= s.startOffset && edit.oldEnd <= s.endOffset) return s
    }
    return null
  }

  async stageClause(changeId: string): Promise<void> {
    const sc = this.inner.findChange(changeId)
    if (!sc) throw new Error("Change not found; diff may have been refreshed.")
    if (sc.stageability.kind !== "stageable") throw new Error(sc.stageability.reason)

    const edit = sc.stageability.edit
    const slice = this.sliceFor(edit)
    if (!slice) throw new Error("Edit spans a file boundary and cannot be staged.")

    const localEdit: SourceEdit = {
      oldStart: edit.oldStart - slice.startOffset,
      oldEnd: edit.oldEnd - slice.startOffset,
      newText: edit.newText,
    }
    const target = applyEdits(slice.oldText, [localEdit])
    const patch = buildPatch(slice.repo.relPath, slice.oldText, target, { isNew: false })
    if (!patch) return
    await applyCachedPatch(slice.repo, patch)
  }

  async stageAll(): Promise<number> {
    let count = 0
    for (const sc of this.stageableChanges()) {
      if (sc.stageability.kind !== "stageable") continue
      try {
        await this.stageClause(sc.change.id)
        count++
      } catch { /* skip unsafe */ }
    }
    return count
  }
}

async function readFileSafe(filePath: string): Promise<string> {
  try { return await fs.readFile(filePath, "utf8") } catch { return "" }
}
