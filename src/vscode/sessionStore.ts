import * as vscode from "vscode"
import * as fs from "fs/promises"
import { Session, SessionMode } from "../session"
import { resolveRepo } from "../git/repository"
import { readIndexBlob, readRefBlob } from "../git/blobReader"
import { BookSession } from "../bookdown/bookSession"
import { BookProject } from "../bookdown/detectProject"

/**
 * Holds one Session per key and keeps working-mode sessions in sync with the
 * buffer and the git index. Historical sessions are rebuilt once on creation
 * and then stay static.
 */
export class SessionStore implements vscode.Disposable {
  private sessions = new Map<string, Session>()
  private bookSessions = new Map<string, BookSession>()
  private emitter = new vscode.EventEmitter<string>()
  readonly onDidRefresh = this.emitter.event

  /** Key for working-mode sessions (just the file path). */
  private static workingKey(filePath: string): string {
    return filePath
  }

  /** Key for historical sessions. */
  static historicalKey(filePath: string, oldRef: string, newRef: string): string {
    return `${filePath}\x00${oldRef}\x00${newRef}`
  }

  get(filePath: string): Session | undefined {
    return this.sessions.get(SessionStore.workingKey(filePath))
  }

  allWorkingSessions(): Session[] {
    return [...this.sessions.values()].filter((s) => !s.isReadOnly)
  }

  getByKey(key: string): Session | undefined {
    return this.sessions.get(key)
  }

  async getOrCreate(filePath: string): Promise<Session> {
    const key = SessionStore.workingKey(filePath)
    let session = this.sessions.get(key)
    if (!session) {
      const repo = await resolveRepo(filePath)
      if (!repo) throw new Error("This file is not inside a git repository.")
      const cfg = vscode.workspace.getConfiguration("semanticStage")
      const conjunctionMinLength = cfg.get<number>("conjunctionMinLength", 60)
      const ignoreListNumbering = cfg.get<boolean>("ignoreOrderedListNumbering", true)
      session = new Session(filePath, repo, conjunctionMinLength, { kind: "working" }, { ignoreListNumbering })
      this.sessions.set(key, session)
    }
    await this.refresh(filePath)
    return session
  }

  /**
   * Creates (or retrieves) a read-only historical session comparing two refs.
   * Returns [session, key].
   */
  async getOrCreateHistorical(
    filePath: string,
    oldRef: string,
    newRef: string
  ): Promise<[Session, string]> {
    const key = SessionStore.historicalKey(filePath, oldRef, newRef)
    let session = this.sessions.get(key)
    if (!session) {
      const repo = await resolveRepo(filePath)
      if (!repo) throw new Error("This file is not inside a git repository.")
      const cfg = vscode.workspace.getConfiguration("semanticStage")
      const conjunctionMinLength = cfg.get<number>("conjunctionMinLength", 60)
      const ignoreListNumbering = cfg.get<boolean>("ignoreOrderedListNumbering", true)
      session = new Session(filePath, repo, conjunctionMinLength, {
        kind: "historical",
        oldRef,
        newRef,
      }, { ignoreListNumbering })
      this.sessions.set(key, session)
      const [oldText, newText] = await Promise.all([
        readRefBlob(repo, oldRef),
        readRefBlob(repo, newRef),
      ])
      session.rebuild(oldText ?? "", newText ?? "")
      this.emitter.fire(key)
    }
    return [session, key]
  }

  async refresh(filePath: string): Promise<void> {
    const session = this.sessions.get(SessionStore.workingKey(filePath))
    if (!session || session.isReadOnly) return
    const [indexText, workingText] = await Promise.all([
      readIndexBlob(session.repo),
      this.readWorkingText(filePath),
    ])
    session.rebuild(indexText, workingText)
    this.emitter.fire(filePath)
  }

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

  getBookByKey(key: string): BookSession | undefined {
    return this.bookSessions.get(key)
  }

  allBookSessions(): BookSession[] {
    return [...this.bookSessions.values()]
  }

  async getOrCreateBook(project: BookProject): Promise<BookSession> {
    const key = project.rootDir
    let book = this.bookSessions.get(key)
    if (!book) {
      const cfg = vscode.workspace.getConfiguration("semanticStage")
      const conjunctionMinLength = cfg.get<number>("conjunctionMinLength", 60)
      const ignoreListNumbering = cfg.get<boolean>("ignoreOrderedListNumbering", true)
      book = new BookSession(project, conjunctionMinLength, { ignoreListNumbering })
      this.bookSessions.set(key, book)
      // Store inner session under rootDir for content/lens/decoration lookups.
      this.sessions.set(key, book.innerSession)
    }
    await this.refreshBook(key)
    return book
  }

  async refreshBook(rootDir: string): Promise<void> {
    const book = this.bookSessions.get(rootDir)
    if (!book) return
    const workingTexts = new Map<string, string>()
    for (const filePath of book.project.chapters) {
      const open = vscode.workspace.textDocuments.find(
        (d) => d.uri.scheme === "file" && d.uri.fsPath === filePath
      )
      if (open) workingTexts.set(filePath, open.getText())
    }
    await book.rebuild(workingTexts)
    this.emitter.fire(rootDir)
  }

  dispose(): void {
    this.sessions.clear()
    this.bookSessions.clear()
    this.emitter.dispose()
  }
}
