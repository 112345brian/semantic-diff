import * as vscode from "vscode"
import { SessionStore } from "../vscode/sessionStore"
import { SCHEME, filePathOf } from "../vscode/virtualDocumentProvider"

/**
 * Switches the diff view between the semantic projection and the raw text —
 * a quick way to verify the projection isn't hiding anything.
 */
export async function toggleProjection(store: SessionStore): Promise<void> {
  const editor = vscode.window.activeTextEditor
  let filePath: string | undefined
  if (editor?.document.uri.scheme === SCHEME) filePath = filePathOf(editor.document.uri)
  else if (editor?.document.uri.scheme === "file") filePath = editor.document.uri.fsPath
  if (!filePath) {
    vscode.window.showWarningMessage("Semantic Stage: open a semantic diff first.")
    return
  }
  const session = store.get(filePath)
  if (!session) {
    vscode.window.showWarningMessage("Semantic Stage: no semantic diff session for this file.")
    return
  }
  session.projectionEnabled = !session.projectionEnabled
  await store.refresh(filePath)
  vscode.window.setStatusBarMessage(
    session.projectionEnabled
      ? "Semantic Stage: projection on"
      : "Semantic Stage: projection off (raw text)",
    3000
  )
}
