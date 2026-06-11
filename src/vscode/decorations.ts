import * as vscode from "vscode"
import { SCHEME, filePathOf, sessionKeyOf } from "./virtualDocumentProvider"
import { SessionStore } from "./sessionStore"
import { SessionChange } from "../session"

/**
 * Decoration scheme:
 *
 *   modified (old side)  amber left border + overview ruler
 *   modified (new side)  blue left border + overview ruler
 *   inserted             green left border + overview ruler
 *   deleted              red left border + overview ruler
 *   unsafe               orange background + overview ruler
 *   synthetic break      faint pilcrow after the line
 *   ignored              greyed-out whole line
 *
 * We use left borders rather than full backgrounds so they layer cleanly
 * over VS Code's own word-level diff highlighting.
 */
export class SemanticStageDecorations implements vscode.Disposable {
  private modifiedOld = decoration({
    borderColor: "rgba(255, 180, 0, 0.8)",
    overviewColor: "rgba(255, 180, 0, 0.9)",
  })
  private modifiedNew = decoration({
    borderColor: "rgba(100, 160, 255, 0.8)",
    overviewColor: "rgba(100, 160, 255, 0.9)",
  })
  private inserted = decoration({
    borderColor: "rgba(80, 200, 100, 0.8)",
    overviewColor: "rgba(80, 200, 100, 0.9)",
  })
  private deleted = decoration({
    borderColor: "rgba(220, 80, 80, 0.8)",
    overviewColor: "rgba(220, 80, 80, 0.9)",
  })
  private moved = decoration({
    borderColor: "rgba(0, 210, 190, 0.8)",
    overviewColor: "rgba(0, 210, 190, 0.9)",
  })
  private unsafe = vscode.window.createTextEditorDecorationType({
    backgroundColor: "rgba(255, 140, 0, 0.15)",
    borderColor: "rgba(255, 140, 0, 0.8)",
    borderWidth: "0 0 0 3px",
    borderStyle: "solid",
    isWholeLine: true,
    overviewRulerColor: "rgba(255, 140, 0, 0.9)",
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  })
  private ignored = vscode.window.createTextEditorDecorationType({
    opacity: "0.4",
    isWholeLine: true,
  })
  private syntheticBreak = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: " ¶",
      color: new vscode.ThemeColor("editorCodeLens.foreground"),
      fontStyle: "normal",
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })

  constructor(private store: SessionStore) {}

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.refreshEditor(editor)
    }
  }

  private refreshEditor(editor: vscode.TextEditor): void {
    const uri = editor.document.uri
    if (uri.scheme !== SCHEME) return
    const key = sessionKeyOf(uri)
    const session = this.store.getByKey(key) ?? this.store.get(filePathOf(uri))
    if (!session) return

    const isOld = uri.authority === "old"
    const lineCount = editor.document.lineCount

    // Synthetic break markers — use the aligned-document index set so markers
    // land on the correct lines even when padding shifts the indices.
    const synthLines = isOld
      ? session.aligned.syntheticBreakLinesOld
      : session.aligned.syntheticBreakLinesNew
    const breakRanges: vscode.Range[] = []
    for (const i of synthLines) {
      if (i >= lineCount) continue
      const len = editor.document.lineAt(i).text.length
      breakRanges.push(new vscode.Range(i, len, i, len))
    }
    editor.setDecorations(this.syntheticBreak, breakRanges)

    // Per-change-type decorations
    const modifiedOldRanges: vscode.Range[] = []
    const modifiedNewRanges: vscode.Range[] = []
    const insertedRanges: vscode.Range[] = []
    const deletedRanges: vscode.Range[] = []
    const movedRanges: vscode.Range[] = []
    const unsafeRanges: vscode.Range[] = []
    const ignoredRanges: vscode.Range[] = []

    for (const sc of session.changes) {
      const { change, stageability, status } = sc

      if (status === "ignored") {
        const idx = session.aligned.changeLineMap.get(change.id)
        if (idx !== undefined) ignoredRanges.push(lineRange(idx, editor))
        continue
      }

      if (stageability.kind === "unsafe") {
        const start = session.aligned.changeLineMap.get(change.id)
        if (start !== undefined) unsafeRanges.push(lineRange(start, editor))
        continue
      }

      const alignedStart = session.aligned.changeLineMap.get(change.id)
      if (alignedStart === undefined) continue

      const oldCount = change.oldStartIndex !== null
        ? change.oldEndIndex! - change.oldStartIndex! + 1 : 0
      const newCount = change.newStartIndex !== null
        ? change.newEndIndex! - change.newStartIndex! + 1 : 0
      const blockLen = Math.max(oldCount, newCount, 1)

      // Detected move pair: teal on both sides, overrides red/green.
      if (change.moveId && session.isMoveActive(change.moveId)) {
        for (let l = alignedStart; l < alignedStart + blockLen; l++) {
          movedRanges.push(lineRange(l, editor))
        }
        continue
      }

      if (change.kind === "modified") {
        for (let l = alignedStart; l < alignedStart + blockLen; l++) {
          if (isOld) modifiedOldRanges.push(lineRange(l, editor))
          else modifiedNewRanges.push(lineRange(l, editor))
        }
      } else if (change.kind === "inserted" && !isOld) {
        for (let l = alignedStart; l < alignedStart + blockLen; l++) {
          insertedRanges.push(lineRange(l, editor))
        }
      } else if (change.kind === "deleted" && isOld) {
        for (let l = alignedStart; l < alignedStart + blockLen; l++) {
          deletedRanges.push(lineRange(l, editor))
        }
      }
    }

    editor.setDecorations(this.modifiedOld, modifiedOldRanges)
    editor.setDecorations(this.modifiedNew, modifiedNewRanges)
    editor.setDecorations(this.inserted, insertedRanges)
    editor.setDecorations(this.deleted, deletedRanges)
    editor.setDecorations(this.moved, movedRanges)
    editor.setDecorations(this.unsafe, unsafeRanges)
    editor.setDecorations(this.ignored, ignoredRanges)
  }

  dispose(): void {
    this.modifiedOld.dispose()
    this.modifiedNew.dispose()
    this.inserted.dispose()
    this.deleted.dispose()
    this.moved.dispose()
    this.unsafe.dispose()
    this.ignored.dispose()
    this.syntheticBreak.dispose()
  }
}

function decoration({ borderColor, overviewColor }: { borderColor: string; overviewColor: string }) {
  return vscode.window.createTextEditorDecorationType({
    borderColor,
    borderWidth: "0 0 0 3px",
    borderStyle: "solid",
    isWholeLine: true,
    overviewRulerColor: overviewColor,
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  })
}

function lineRange(lineIndex: number, editor: vscode.TextEditor): vscode.Range {
  const clamped = Math.max(0, Math.min(lineIndex, editor.document.lineCount - 1))
  return new vscode.Range(clamped, 0, clamped, editor.document.lineAt(clamped).text.length)
}

