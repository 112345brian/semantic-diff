import * as vscode from "vscode"
import { SessionStore } from "../vscode/sessionStore"
import { SCHEME, filePathOf } from "../vscode/virtualDocumentProvider"
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
  const session = store.get(filePath)
  if (!session) return
  const sc = session.findChange(changeId)
  if (!sc) {
    vscode.window.showWarningMessage("Semantic Stage: this clause is no longer current; the diff has been refreshed.")
    await store.refresh(filePath)
    return
  }
  if (sc.stageability.kind !== "stageable") {
    vscode.window.showWarningMessage(`Semantic Stage: ${sc.stageability.reason}`)
    return
  }
  try {
    await stageEdits(session, [sc.stageability.edit])
    await store.refresh(filePath)
    vscode.window.setStatusBarMessage("Semantic Stage: clause staged", 3000)
  } catch (err: any) {
    vscode.window.showErrorMessage(`Semantic Stage: ${err.message ?? err}`)
  }
}

/**
 * Palette version: stages the clause under the cursor in the semantic diff
 * view.
 */
export async function stageHunkAtCursor(store: SessionStore): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.uri.scheme !== SCHEME) {
    vscode.window.showWarningMessage("Semantic Stage: place the cursor in a semantic diff view first.")
    return
  }
  const filePath = filePathOf(editor.document.uri)
  const session = store.get(filePath)
  if (!session) return
  const line = editor.selection.active.line
  const onNewSide = editor.document.uri.authority === "new"

  const match = session.changes.find((sc) => coversLine(sc, line, onNewSide))
  if (!match) {
    vscode.window.showInformationMessage("Semantic Stage: no changed clause at the cursor.")
    return
  }
  await stageClause(store, filePath, match.change.id)
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
  if (editor?.document.uri.scheme === SCHEME) filePath = filePathOf(editor.document.uri)
  else if (editor?.document.uri.scheme === "file") filePath = editor.document.uri.fsPath
  if (!filePath) {
    vscode.window.showWarningMessage("Semantic Stage: open a semantic diff first.")
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
        ? `Semantic Stage: nothing stageable; ${skipped.length} unsafe change(s) skipped.`
        : "Semantic Stage: nothing to stage."
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
        ? `Semantic Stage: staged ${staged} clause change(s); skipped ${skipped.length} unsafe.`
        : `Semantic Stage: staged ${staged} clause change(s).`
    vscode.window.showInformationMessage(summary)
  } catch (err: any) {
    vscode.window.showErrorMessage(`Semantic Stage: ${err.message ?? err}`)
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

/** Opens VS Code's native index↔working-tree diff for the file. */
export async function showRaw(store: SessionStore, filePath: string): Promise<void> {
  const uri = vscode.Uri.file(filePath)
  try {
    await vscode.commands.executeCommand("git.openChange", uri)
  } catch {
    await vscode.commands.executeCommand("vscode.open", uri)
  }
}
