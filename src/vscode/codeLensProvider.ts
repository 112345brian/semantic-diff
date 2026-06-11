import * as vscode from "vscode"
import { Session, SessionChange } from "../session"
import { SCHEME, filePathOf } from "./virtualDocumentProvider"

/**
 * One CodeLens row per changed clause, shown on the new (right) side of the
 * diff. Deleted clauses anchor to the position in the new text where the
 * deletion happened.
 */
export class SemanticStageCodeLensProvider implements vscode.CodeLensProvider {
  private emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeCodeLenses = this.emitter.event

  constructor(private getSession: (filePath: string) => Session | undefined) {}

  refresh(): void {
    this.emitter.fire()
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== SCHEME || document.uri.authority !== "new") return []
    const filePath = filePathOf(document.uri)
    const session = this.getSession(filePath)
    if (!session || !session.projectionEnabled) return []

    const lenses: vscode.CodeLens[] = []
    for (const sc of session.changes) {
      const line = lensLine(sc, document)
      const range = new vscode.Range(line, 0, line, 0)
      for (const lens of lensesForChange(sc, filePath)) {
        lenses.push(new vscode.CodeLens(range, lens))
      }
    }
    return lenses
  }
}

function lensLine(sc: SessionChange, document: vscode.TextDocument): number {
  const idx = sc.change.newStartIndex ?? sc.change.anchorNewIndex + 1
  return Math.max(0, Math.min(idx, document.lineCount - 1))
}

function lensesForChange(sc: SessionChange, filePath: string): vscode.Command[] {
  const id = sc.change.id

  if (sc.status === "ignored") {
    return [
      {
        title: "Ignored — Undo",
        command: "semanticStage.unignoreClause",
        arguments: [filePath, id],
      },
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
