import * as vscode from "vscode"
import { Session } from "../session"
import { SessionStore } from "./sessionStore"

export const SCHEME = "semantic-stage"

export function oldUri(filePath: string, sessionKey?: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: SCHEME,
    authority: "old",
    path: filePath,
    query: sessionKey ? encodeURIComponent(sessionKey) : "",
  })
}

export function newUri(filePath: string, sessionKey?: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: SCHEME,
    authority: "new",
    path: filePath,
    query: sessionKey ? encodeURIComponent(sessionKey) : "",
  })
}

export function filePathOf(uri: vscode.Uri): string {
  return uri.path
}

export function sessionKeyOf(uri: vscode.Uri): string {
  return uri.query ? decodeURIComponent(uri.query) : uri.path
}

export class SemanticStageContentProvider implements vscode.TextDocumentContentProvider {
  private emitter = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidChange = this.emitter.event

  constructor(private store: SessionStore) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const key = sessionKeyOf(uri)
    const session = this.store.getByKey(key) ?? this.store.get(filePathOf(uri))
    if (!session) return ""
    return uri.authority === "old" ? session.aligned.oldText : session.aligned.newText
  }

  refresh(key: string): void {
    // Book session: key is rootDir, stored in sessions map under rootDir.
    if (this.store.getBookByKey(key)) {
      this.emitter.fire(oldUri("/__BOOK__", key))
      this.emitter.fire(newUri("/__BOOK__", key))
      return
    }
    // Historical: key is filePath\x00oldRef\x00newRef.
    const parts = key.split("\x00")
    const filePath = parts[0]
    if (parts.length === 3) {
      this.emitter.fire(oldUri(filePath, key))
      this.emitter.fire(newUri(filePath, key))
    } else {
      this.emitter.fire(oldUri(filePath))
      this.emitter.fire(newUri(filePath))
    }
  }
}
