import * as vscode from "vscode"
import { SessionStore } from "./sessionStore"
import { SCHEME, filePathOf } from "./virtualDocumentProvider"
import { ProjectedLine } from "../types/projection"

export class ClauseStatusBar implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
  private disposables: vscode.Disposable[] = []

  constructor(private store: SessionStore) {
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(() => this.refresh()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      store.onDidRefresh(() => this.refresh())
    )
    this.refresh()
  }

  private refresh(): void {
    const editor = vscode.window.activeTextEditor
    if (!editor) { this.item.hide(); return }

    const uri = editor.document.uri
    let session = this.store.get(uri.fsPath)
    if (!session && uri.scheme === SCHEME) {
      session = this.store.getByKey(uri.query ? decodeURIComponent(uri.query) : uri.path)
        ?? this.store.get(filePathOf(uri))
    }
    if (!session) { this.item.hide(); return }

    const proj = uri.scheme === SCHEME && uri.authority === "old"
      ? session.oldProjection
      : session.newProjection

    const offset = editor.document.offsetAt(editor.selection.active)
    const idx = clauseAtOffset(proj.lines, offset)
    if (idx === null) { this.item.hide(); return }

    this.item.text = `$(list-ordered) Clause ${idx + 1}`
    this.item.tooltip = "Semantic Diff: projected clause at cursor"
    this.item.show()
  }

  dispose(): void {
    this.item.dispose()
    for (const d of this.disposables) d.dispose()
  }
}

export function clauseAtOffset(lines: ProjectedLine[], offset: number): number | null {
  let result: number | null = null
  for (let i = 0; i < lines.length; i++) {
    const span = lines[i].sourceSpan
    if (!span) continue
    if (span.startOffset > offset) break
    result = i
  }
  return result
}
