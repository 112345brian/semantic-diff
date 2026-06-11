import * as vscode from "vscode"
import { Session } from "../session"

export const SCHEME = "semantic-stage"

export function oldUri(filePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, authority: "old", path: filePath })
}

export function newUri(filePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, authority: "new", path: filePath })
}

export function filePathOf(uri: vscode.Uri): string {
  return uri.path
}

/**
 * Serves the projected texts for both sides of the diff. The documents are
 * read-only review surfaces; the real file is never replaced by them.
 */
export class SemanticStageContentProvider implements vscode.TextDocumentContentProvider {
  private emitter = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidChange = this.emitter.event

  constructor(private getSession: (filePath: string) => Session | undefined) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const session = this.getSession(filePathOf(uri))
    if (!session) return ""
    return uri.authority === "old"
      ? session.oldProjection.projectedText
      : session.newProjection.projectedText
  }

  refresh(filePath: string): void {
    this.emitter.fire(oldUri(filePath))
    this.emitter.fire(newUri(filePath))
  }
}
