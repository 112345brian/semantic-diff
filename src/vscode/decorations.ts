import * as vscode from "vscode"
import { Session } from "../session"
import { SCHEME, filePathOf } from "./virtualDocumentProvider"

/**
 * Decorations on the projected documents:
 *  - a faint pilcrow after lines whose newline is synthetic (so the writer
 *    can tell review-surface breaks from real ones)
 *  - a warning background on unsafe clauses
 */
export class SemanticStageDecorations implements vscode.Disposable {
  private syntheticBreak = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: " ¶",
      color: new vscode.ThemeColor("editorCodeLens.foreground"),
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })

  private unsafeClause = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("inputValidation.warningBackground"),
    isWholeLine: true,
  })

  constructor(private getSession: (filePath: string) => Session | undefined) {}

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.refreshEditor(editor)
    }
  }

  private refreshEditor(editor: vscode.TextEditor): void {
    const uri = editor.document.uri
    if (uri.scheme !== SCHEME) return
    const session = this.getSession(filePathOf(uri))
    if (!session) return

    const projection =
      uri.authority === "old" ? session.oldProjection : session.newProjection

    const breakRanges: vscode.Range[] = []
    for (let i = 0; i < projection.lines.length; i++) {
      if (projection.lines[i].syntheticEol) {
        const lineLen = projection.lines[i].text.length
        breakRanges.push(new vscode.Range(i, lineLen, i, lineLen))
      }
    }
    editor.setDecorations(this.syntheticBreak, breakRanges)

    const unsafeRanges: vscode.Range[] = []
    if (uri.authority === "new") {
      for (const sc of session.changes) {
        if (sc.stageability.kind !== "unsafe" || sc.status === "ignored") continue
        const start = sc.change.newStartIndex ?? sc.change.anchorNewIndex + 1
        const end = sc.change.newEndIndex ?? start
        unsafeRanges.push(new vscode.Range(Math.max(0, start), 0, Math.max(0, end), 0))
      }
    }
    editor.setDecorations(this.unsafeClause, unsafeRanges)
  }

  dispose(): void {
    this.syntheticBreak.dispose()
    this.unsafeClause.dispose()
  }
}
