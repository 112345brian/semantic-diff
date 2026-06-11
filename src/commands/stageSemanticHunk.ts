import * as vscode from "vscode"
import { SessionStore } from "../vscode/sessionStore"
import { SCHEME, filePathOf, sessionKeyOf } from "../vscode/virtualDocumentProvider"
import { Session, SessionChange } from "../session"
import { applyEdits, buildPatch } from "../git/patchBuilder"
import { applyCachedPatch } from "../git/applyPatch"
import { SourceEdit } from "../types/diff"

async function stageEdits(session: Session, edits: SourceEdit[]): Promise<void> {
  const target = applyEdits(session.oldText, edits)
  const patch = buildPatch(session.repo.relPath, session.oldText, target, {
    isNew: session.isNew,
  })
  if (!patch) return
  await applyCachedPatch(session.repo, patch)
}

export async function stageClause(
  store: SessionStore,
  filePath: string,
  changeId: string
): Promise<void> {
  // filePath may be a rootDir key for book sessions.
  const book = store.getBookByKey(filePath)
  if (book) {
    try {
      await book.stageClause(changeId)
      await store.refreshBook(book.rootDir)
      vscode.window.setStatusBarMessage("Semantic Diff: clause staged", 3000)
    } catch (err: any) {
      vscode.window.showErrorMessage(`Semantic Diff: ${err.message ?? err}`)
    }
    return
  }

  const session = store.get(filePath)
  if (!session) return
  const sc = session.findChange(changeId)
  if (!sc) {
    vscode.window.showWarningMessage("Semantic Diff: this clause is no longer current; the diff has been refreshed.")
    await store.refresh(filePath)
    return
  }
  if (sc.stageability.kind !== "stageable") {
    vscode.window.showWarningMessage(`Semantic Diff: ${sc.stageability.reason}`)
    return
  }
  try {
    await stageEdits(session, [sc.stageability.edit])
    await store.refresh(filePath)
    vscode.window.setStatusBarMessage("Semantic Diff: clause staged", 3000)
  } catch (err: any) {
    vscode.window.showErrorMessage(`Semantic Diff: ${err.message ?? err}`)
  }
}

/**
 * Palette version: stages the clause under the cursor in the semantic diff
 * view.
 */
export async function stageHunkAtCursor(store: SessionStore): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.uri.scheme !== SCHEME) {
    vscode.window.showWarningMessage("Semantic Diff: place the cursor in a semantic diff view first.")
    return
  }
  const key = sessionKeyOf(editor.document.uri)
  const filePath = filePathOf(editor.document.uri)
  const session = store.getByKey(key) ?? store.get(filePath)
  if (!session) return
  const line = editor.selection.active.line
  const onNewSide = editor.document.uri.authority === "new"

  const match = session.changes.find((sc) => coversLine(sc, line, onNewSide))
  if (!match) {
    vscode.window.showInformationMessage("Semantic Diff: no changed clause at the cursor.")
    return
  }
  await stageClause(store, key, match.change.id)
}

function coversLine(sc: SessionChange, line: number, onNewSide: boolean): boolean {
  const start = onNewSide ? sc.change.newStartIndex : sc.change.oldStartIndex
  const end = onNewSide ? sc.change.newEndIndex : sc.change.oldEndIndex
  if (start === null || end === null) return false
  return line >= start && line <= end
}

export async function stageAll(store: SessionStore, arg?: unknown): Promise<void> {
  const editor = vscode.window.activeTextEditor
  let filePath: string | undefined
  let sessionKey: string | undefined
  if (editor?.document.uri.scheme === SCHEME) {
    filePath = filePathOf(editor.document.uri)
    sessionKey = sessionKeyOf(editor.document.uri)
  } else if (editor?.document.uri.scheme === "file") {
    filePath = editor.document.uri.fsPath
    sessionKey = filePath
  }
  if (!filePath || !sessionKey) {
    vscode.window.showWarningMessage("Semantic Diff: open a semantic diff first.")
    return
  }

  // Book session: stage all via BookSession to get per-file routing.
  const book = store.getBookByKey(sessionKey)
  if (book) {
    try {
      const count = await book.stageAll()
      await store.refreshBook(book.rootDir)
      vscode.window.showInformationMessage(`Semantic Diff: staged ${count} clause change(s).`)
    } catch (err: any) {
      vscode.window.showErrorMessage(`Semantic Diff: ${err.message ?? err}`)
    }
    return
  }

  const session = store.get(filePath) ?? (await store.getOrCreate(filePath))

  const stageables = session.stageableChanges()
  const skipped = session.changes.filter(
    (c) => c.status === "pending" && c.stageability.kind === "unsafe"
  )
  if (stageables.length === 0) {
    vscode.window.showInformationMessage(
      skipped.length > 0
        ? `Semantic Diff: nothing stageable; ${skipped.length} unsafe change(s) skipped.`
        : "Semantic Diff: nothing to stage."
    )
    return
  }
  try {
    let staged = 0
    const edits = stageables.map(
      (c) => (c.stageability as { kind: "stageable"; edit: SourceEdit }).edit
    )
    try {
      await stageEdits(session, edits)
      staged = stageables.length
      await store.refresh(filePath)
    } catch {
      // Rare overlapping edits (e.g. two paragraph insertions at the same
      // anchor): stage one change at a time, rebuilding between rounds.
      staged = await stageSequentially(store, session, filePath)
    }
    const summary =
      skipped.length > 0
        ? `Semantic Diff: staged ${staged} clause change(s); skipped ${skipped.length} unsafe.`
        : `Semantic Diff: staged ${staged} clause change(s).`
    vscode.window.showInformationMessage(summary)
  } catch (err: any) {
    vscode.window.showErrorMessage(`Semantic Diff: ${err.message ?? err}`)
  }
}

async function stageSequentially(
  store: SessionStore,
  session: Session,
  filePath: string
): Promise<number> {
  let staged = 0
  for (let round = 0; round < 100; round++) {
    const next = session.stageableChanges()[0]
    if (!next) break
    await stageEdits(session, [(next.stageability as { kind: "stageable"; edit: SourceEdit }).edit])
    staged++
    await store.refresh(filePath)
  }
  return staged
}

export async function stageAllFiles(store: SessionStore): Promise<void> {
  const sessions = store.allWorkingSessions()
  if (sessions.length === 0) {
    vscode.window.showInformationMessage("Semantic Diff: no open sessions.")
    return
  }
  let totalStaged = 0
  let totalSkipped = 0
  for (const session of sessions) {
    const stageables = session.stageableChanges()
    const skipped = session.changes.filter(
      (c) => c.status === "pending" && c.stageability.kind === "unsafe"
    ).length
    totalSkipped += skipped
    if (stageables.length === 0) continue
    try {
      const edits = stageables.map(
        (c) => (c.stageability as { kind: "stageable"; edit: SourceEdit }).edit
      )
      await stageEdits(session, edits)
      totalStaged += stageables.length
      await store.refresh(session.filePath)
    } catch {
      for (const sc of stageables) {
        try {
          await stageEdits(session, [(sc.stageability as { kind: "stageable"; edit: SourceEdit }).edit])
          totalStaged++
          await store.refresh(session.filePath)
        } catch { /* skip */ }
      }
    }
  }
  const msg = totalSkipped > 0
    ? `Semantic Diff: staged ${totalStaged} clause change(s) across ${sessions.length} file(s); ${totalSkipped} unsafe skipped.`
    : `Semantic Diff: staged ${totalStaged} clause change(s) across ${sessions.length} file(s).`
  vscode.window.showInformationMessage(msg)
}

export async function stageMove(
  store: SessionStore,
  filePath: string,
  moveId: string
): Promise<void> {
  // filePath may be a rootDir key for book sessions.
  const book = store.getBookByKey(filePath)
  if (book) {
    const pair = book.findChangesForMove(moveId)
    if (!pair) {
      vscode.window.showWarningMessage("Semantic Diff: move pair not found; diff may have been refreshed.")
      await store.refreshBook(book.rootDir)
      return
    }
    const [a, b] = pair
    if (a.stageability.kind !== "stageable" || b.stageability.kind !== "stageable") {
      vscode.window.showWarningMessage("Semantic Diff: move cannot be staged — edit spans a file boundary.")
      return
    }
    try {
      await book.stageClause(a.change.id)
      await book.stageClause(b.change.id)
      await store.refreshBook(book.rootDir)
      vscode.window.setStatusBarMessage("Semantic Diff: move staged", 3000)
    } catch (err: any) {
      vscode.window.showErrorMessage(`Semantic Diff: ${err.message ?? err}`)
    }
    return
  }

  const session = store.get(filePath)
  if (!session) return
  const pair = session.findChangesForMove(moveId)
  if (!pair) {
    vscode.window.showWarningMessage("Semantic Diff: move pair not found; diff may have been refreshed.")
    await store.refresh(filePath)
    return
  }
  const [a, b] = pair
  if (a.stageability.kind !== "stageable") {
    vscode.window.showWarningMessage(`Semantic Diff: ${a.stageability.reason}`)
    return
  }
  if (b.stageability.kind !== "stageable") {
    vscode.window.showWarningMessage(`Semantic Diff: ${b.stageability.reason}`)
    return
  }
  try {
    await stageEdits(session, [a.stageability.edit, b.stageability.edit])
    await store.refresh(filePath)
    vscode.window.setStatusBarMessage("Semantic Diff: move staged", 3000)
  } catch (err: any) {
    vscode.window.showErrorMessage(`Semantic Diff: ${err.message ?? err}`)
  }
}

/** Opens VS Code's native index↔working-tree diff for the file. */
export async function showRaw(store: SessionStore, filePath: string): Promise<void> {
  const uri = vscode.Uri.file(filePath)
  try {
    await vscode.commands.executeCommand("git.openChange", uri)
  } catch {
    await vscode.commands.executeCommand("vscode.open", uri)
  }
}
