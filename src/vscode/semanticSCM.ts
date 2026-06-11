import * as vscode from "vscode"
import { SessionStore } from "./sessionStore"
import { oldUri, newUri } from "./virtualDocumentProvider"
import * as path from "path"

/**
 * Surfaces files with pending semantic clause changes in VS Code's Source
 * Control panel. Clicking a file opens the semantic diff for it.
 */
export class SemanticSCM implements vscode.Disposable {
  private scm: vscode.SourceControl
  private group: vscode.SourceControlResourceGroup
  private disposables: vscode.Disposable[] = []

  constructor(private store: SessionStore) {
    this.scm = vscode.scm.createSourceControl("semanticDiff", "Semantic Diff")
    this.scm.statusBarCommands = []
    this.group = this.scm.createResourceGroup("pending", "Pending Clause Changes")
    this.group.hideWhenEmpty = true
    this.disposables.push(store.onDidRefresh(() => this.refresh()))
    this.refresh()
  }

  private refresh(): void {
    const resources: vscode.SourceControlResourceState[] = []
    for (const session of this.store.allWorkingSessions()) {
      const pending = session.changes.filter(
        (c) => c.status === "pending" && c.stageability.kind === "stageable"
      )
      if (pending.length === 0) continue

      const modified = pending.filter((c) => c.change.kind === "modified").length
      const inserted = pending.filter((c) => c.change.kind === "inserted").length
      const deleted = pending.filter((c) => c.change.kind === "deleted").length
      const moved = pending.filter(
        (c) => c.change.moveId && session.isMoveActive(c.change.moveId)
      ).length / 2  // each move counts as two changes

      const parts: string[] = []
      if (modified > 0) parts.push(`${modified} modified`)
      if (inserted > 0) parts.push(`${inserted} inserted`)
      if (deleted > 0) parts.push(`${deleted} deleted`)
      if (moved > 0) parts.push(`${Math.round(moved)} moved`)

      resources.push({
        resourceUri: vscode.Uri.file(session.filePath),
        decorations: {
          tooltip: parts.join(", "),
          strikeThrough: false,
          faded: false,
        },
        command: {
          title: "Open Semantic Diff",
          command: "semanticDiff.openDiff",
          arguments: [vscode.Uri.file(session.filePath)],
        },
      })
    }
    this.group.resourceStates = resources
    this.scm.count = resources.length
  }

  dispose(): void {
    this.scm.dispose()
    for (const d of this.disposables) d.dispose()
  }
}
