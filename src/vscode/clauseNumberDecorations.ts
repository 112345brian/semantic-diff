import * as vscode from "vscode"
import { SessionStore } from "./sessionStore"

const STORAGE_KEY = "semanticDiff.clauseNumberFiles"

/**
 * Renders faint inline [N] markers at each clause-start position in real file
 * editors. Uses the session's new-side projection source spans to locate each
 * clause within the original text. Toggled per file and persisted across
 * sessions via workspace state.
 */
export class ClauseNumberDecorations implements vscode.Disposable {
  private decoration = vscode.window.createTextEditorDecorationType({
    before: {
      color: new vscode.ThemeColor("editorCodeLens.foreground"),
      fontStyle: "normal",
      margin: "0 2px 0 0",
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  })

  private enabledFiles: Set<string>
  private disposables: vscode.Disposable[] = []

  constructor(
    private store: SessionStore,
    private workspaceState: vscode.Memento
  ) {
    this.enabledFiles = new Set(
      workspaceState.get<string[]>(STORAGE_KEY, [])
    )
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()),
      store.onDidRefresh(() => this.refreshAll())
    )
  }

  toggle(filePath: string): void {
    if (this.enabledFiles.has(filePath)) {
      this.enabledFiles.delete(filePath)
    } else {
      this.enabledFiles.add(filePath)
    }
    void this.workspaceState.update(STORAGE_KEY, [...this.enabledFiles])
    this.refreshAll()
  }

  isEnabled(filePath: string): boolean {
    return this.enabledFiles.has(filePath)
  }

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.refreshEditor(editor)
    }
  }

  private refreshEditor(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme !== "file") return
    const filePath = editor.document.uri.fsPath
    if (!this.enabledFiles.has(filePath)) {
      editor.setDecorations(this.decoration, [])
      return
    }
    const session = this.store.get(filePath)
    if (!session) {
      editor.setDecorations(this.decoration, [])
      return
    }

    const proj = session.newProjection
    const text = editor.document.getText()
    const ranges: vscode.DecorationOptions[] = []

    for (let i = 0; i < proj.lines.length; i++) {
      const line = proj.lines[i]
      if (!line.syntheticEol) continue          // only annotate clause lines
      const span = line.sourceSpan
      if (!span) continue

      // Find which character in the document the clause starts at.
      const pos = offsetToPosition(text, span.startOffset)
      if (!pos) continue

      // Skip first clause on its line if it's at column 0 — the file line
      // number already serves as a marker there.
      const isFirstOnLine = pos.character === 0
      const label = isFirstOnLine ? `[${i + 1}] ` : ` [${i + 1}] `

      ranges.push({
        range: new vscode.Range(pos, pos),
        renderOptions: { before: { contentText: label } },
      })
    }

    editor.setDecorations(this.decoration, ranges)
  }

  dispose(): void {
    this.decoration.dispose()
    for (const d of this.disposables) d.dispose()
  }
}

function offsetToPosition(text: string, offset: number): vscode.Position | null {
  if (offset < 0 || offset > text.length) return null
  let line = 0
  let col = 0
  for (let i = 0; i < offset; i++) {
    if (text[i] === "\n") { line++; col = 0 } else { col++ }
  }
  return new vscode.Position(line, col)
}
