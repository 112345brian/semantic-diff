import * as vscode from "vscode"
import * as path from "path"
import { SessionStore } from "../vscode/sessionStore"
import { oldUri, newUri, SCHEME, filePathOf } from "../vscode/virtualDocumentProvider"

/** Resolves the target file from a command argument or the active editor. */
export function resolveTargetFile(arg?: unknown): string | undefined {
  if (arg instanceof vscode.Uri && arg.scheme === "file") return arg.fsPath
  if (arg && typeof arg === "object" && "resourceUri" in arg) {
    const uri = (arg as { resourceUri: vscode.Uri }).resourceUri
    if (uri?.scheme === "file") return uri.fsPath
  }
  const active = vscode.window.activeTextEditor
  if (!active) return undefined
  if (active.document.uri.scheme === "file") return active.document.uri.fsPath
  if (active.document.uri.scheme === SCHEME) return filePathOf(active.document.uri)
  return undefined
}

export async function openSemanticDiff(store: SessionStore, arg?: unknown): Promise<void> {
  const filePath = resolveTargetFile(arg)
  if (!filePath) {
    vscode.window.showWarningMessage("Semantic Stage: open a file first.")
    return
  }
  try {
    await store.getOrCreate(filePath)
  } catch (err: any) {
    vscode.window.showErrorMessage(`Semantic Stage: ${err.message ?? err}`)
    return
  }
  await ensureDiffSettings()
  const title = `${path.basename(filePath)} (Semantic Diff: index ↔ working tree)`
  await vscode.commands.executeCommand("vscode.diff", oldUri(filePath), newUri(filePath), title)
}

/**
 * Ensures the diff editor is in side-by-side mode with word wrap on.
 * Both are important for prose review: side-by-side shows old and new
 * simultaneously; word wrap keeps long clauses readable without horizontal
 * scrolling.
 */
export async function ensureDiffSettings(): Promise<void> {
  const config = vscode.workspace.getConfiguration()
  if (config.get("diffEditor.renderSideBySide") !== true) {
    await config.update("diffEditor.renderSideBySide", true, vscode.ConfigurationTarget.Global)
  }
  if (config.get("diffEditor.wordWrap") !== "on") {
    await config.update("diffEditor.wordWrap", "on", vscode.ConfigurationTarget.Global)
  }
}

export async function toggleSplitPane(): Promise<void> {
  const config = vscode.workspace.getConfiguration()
  const current = config.get<boolean>("diffEditor.renderSideBySide") ?? true
  await config.update("diffEditor.renderSideBySide", !current, vscode.ConfigurationTarget.Global)
}
