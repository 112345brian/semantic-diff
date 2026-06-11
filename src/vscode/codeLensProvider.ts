import * as vscode from "vscode"
import { Session, SessionChange } from "../session"
import { SCHEME, filePathOf, sessionKeyOf } from "./virtualDocumentProvider"
import { SessionStore } from "./sessionStore"


/**
 * One CodeLens row per changed clause, shown on the new (right) side of the
 * diff. Deleted clauses anchor to the position in the new text where the
 * deletion happened. Read-only (historical) sessions show a summary label
 * only — no staging actions.
 */
export class SemanticStageCodeLensProvider implements vscode.CodeLensProvider {
  private emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeCodeLenses = this.emitter.event

  constructor(private store: SessionStore) {}

  refresh(): void {
    this.emitter.fire()
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== SCHEME || document.uri.authority !== "new") return []
    const filePath = filePathOf(document.uri)
    const key = sessionKeyOf(document.uri)
    const session = this.store.getByKey(key) ?? this.store.get(filePath)
    if (!session || !session.projectionEnabled) return []

    // For book sessions the key is the rootDir; for regular sessions key === filePath.
    const lensFilePath = key

    const lenses: vscode.CodeLens[] = []
    for (const sc of session.changes) {
      const line = session.aligned.changeLineMap.get(sc.change.id) ?? 0
      const clamped = Math.max(0, Math.min(line, document.lineCount - 1))
      const range = new vscode.Range(clamped, 0, clamped, 0)
      for (const lens of lensesForChange(sc, session, lensFilePath, session.isReadOnly)) {
        lenses.push(new vscode.CodeLens(range, lens))
      }
    }
    return lenses
  }
}

function lensesForChange(sc: SessionChange, session: Session, filePath: string, readOnly: boolean): vscode.Command[] {
  if (readOnly) {
    const kind = sc.change.kind === "modified" ? "modified" :
      sc.change.kind === "inserted" ? "inserted" : "deleted"
    const moveTag = sc.change.moveId ? " (moved)" : ""
    return [{ title: `$(diff) ${kind} clause${moveTag}`, command: "" }]
  }
  const id = sc.change.id
  const moveId = sc.change.moveId

  // Move pair that hasn't been split: show move-specific actions.
  if (moveId && session.isMoveActive(moveId)) {
    if (sc.status === "ignored") {
      return [
        { title: "↕ Move ignored — Undo", command: "semanticStage.unignoreMove", arguments: [filePath, moveId] },
      ]
    }
    const isSrcSide = sc.change.kind === "deleted"
    return [
      { title: isSrcSide ? "↕ Moved from here — Stage move" : "↕ Moved here — Stage move", command: "semanticStage.stageMove", arguments: [filePath, moveId] },
      { title: "Split", command: "semanticStage.splitMove", arguments: [filePath, moveId] },
      { title: "Ignore", command: "semanticStage.ignoreMove", arguments: [filePath, moveId] },
    ]
  }

  if (sc.status === "ignored") {
    return [
      { title: "Ignored — Undo", command: "semanticStage.unignoreClause", arguments: [filePath, id] },
    ]
  }

  if (sc.stageability.kind === "unsafe") {
    return [
      { title: `⚠ Not stageable: ${sc.stageability.reason}`, command: "" },
      { title: "Show raw", command: "semanticStage.showRaw", arguments: [filePath, id] },
    ]
  }

  const clauseCount =
    sc.change.kind === "deleted"
      ? sc.change.oldEndIndex! - sc.change.oldStartIndex! + 1
      : sc.change.newEndIndex! - sc.change.newStartIndex! + 1
  const noun = clauseCount === 1 ? "clause" : `${clauseCount} clauses`
  const verb =
    sc.change.kind === "inserted"
      ? `Stage inserted ${noun}`
      : sc.change.kind === "deleted"
        ? `Stage deleted ${noun}`
        : `Stage ${noun}`

  return [
    { title: verb, command: "semanticStage.stageClause", arguments: [filePath, id] },
    { title: "Ignore", command: "semanticStage.ignoreClause", arguments: [filePath, id] },
    { title: "Show raw", command: "semanticStage.showRaw", arguments: [filePath, id] },
  ]
}
