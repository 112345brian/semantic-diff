import * as vscode from "vscode"
import * as fs from "fs/promises"
import { Session } from "../session"
import { resolveRepo } from "../git/repository"
import { readIndexBlob } from "../git/blobReader"

/**
 * Holds one Session per file and keeps it in sync with the working buffer
 * and the git index.
 */
export class SessionStore implements vscode.Disposable {
  private sessions = new Map<string, Session>()
  private emitter = new vscode.EventEmitter<string>()
  /** Fires with the file path whenever a session is rebuilt. */
  readonly onDidRefresh = this.emitter.event

  get(filePath: string): Session | undefined {
    return this.sessions.get(filePath)
  }

  async getOrCreate(filePath: string): Promise<Session> {
    let session = this.sessions.get(filePath)
    if (!session) {
      const repo = await resolveRepo(filePath)
      if (!repo) {
        throw new Error("This file is not inside a git repository.")
      }
      const conjunctionMinLength = vscode.workspace
        .getConfiguration("semanticStage")
        .get<number>("conjunctionMinLength", 60)
      session = new Session(filePath, repo, conjunctionMinLength)
      this.sessions.set(filePath, session)
    }
    await this.refresh(filePath)
    return session
  }

  async refresh(filePath: string): Promise<void> {
    const session = this.sessions.get(filePath)
    if (!session) return
    const [indexText, workingText] = await Promise.all([
      readIndexBlob(session.repo),
      this.readWorkingText(filePath),
    ])
    session.rebuild(indexText, workingText)
    this.emitter.fire(filePath)
  }

  /**
   * Prefers the open editor buffer over disk so unsaved edits are reflected
   * in the diff immediately.
   */
  private async readWorkingText(filePath: string): Promise<string> {
    const open = vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === "file" && d.uri.fsPath === filePath
    )
    if (open) return open.getText()
    try {
      return await fs.readFile(filePath, "utf8")
    } catch {
      return ""
    }
  }

  dispose(): void {
    this.sessions.clear()
    this.emitter.dispose()
  }
}
