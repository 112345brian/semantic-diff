import * as vscode from "vscode"
import * as path from "path"
import { SessionStore } from "../vscode/sessionStore"
import { detectBookProject } from "../bookdown/detectProject"
import { oldUri, newUri } from "../vscode/virtualDocumentProvider"

export async function openBookDiff(store: SessionStore): Promise<void> {
  let startDir: string | undefined
  const editor = vscode.window.activeTextEditor
  if (editor?.document.uri.scheme === "file") {
    startDir = path.dirname(editor.document.uri.fsPath)
  } else {
    startDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  }
  if (!startDir) {
    vscode.window.showErrorMessage("Semantic Diff: open a chapter file or workspace to detect a book project.")
    return
  }

  const project = await detectBookProject(startDir)
  if (!project) {
    vscode.window.showErrorMessage("Semantic Diff: no bookdown or quarto project found (looked for _bookdown.yml / _quarto.yml).")
    return
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Semantic Diff: loading book diff…" },
    async () => { await store.getOrCreateBook(project) }
  )

  const key = project.rootDir
  await vscode.commands.executeCommand(
    "vscode.diff",
    oldUri("/__BOOK__", key),
    newUri("/__BOOK__", key),
    `Book Diff — ${path.basename(project.rootDir)} (${project.kind})`
  )
}
