import * as vscode from "vscode"
import { SessionStore } from "./vscode/sessionStore"
import {
  SemanticStageContentProvider,
  SCHEME,
  filePathOf,
} from "./vscode/virtualDocumentProvider"
import { SemanticStageCodeLensProvider } from "./vscode/codeLensProvider"
import { SemanticStageDecorations } from "./vscode/decorations"
import { ClauseNumberDecorations } from "./vscode/clauseNumberDecorations"
import { ClauseStatusBar, clauseAtOffset } from "./vscode/clauseStatusBar"
import { SemanticSCM } from "./vscode/semanticSCM"
import { openSemanticDiff, toggleSplitPane } from "./commands/openSemanticDiff"
import {
  stageClause,
  stageHunkAtCursor,
  stageAll,
  stageAllFiles,
  stageMove,
  showRaw,
} from "./commands/stageSemanticHunk"
import { toggleProjection } from "./commands/toggleProjection"
import { openHistoricalDiff } from "./commands/openHistoricalDiff"
import { openBookDiff } from "./commands/openBookDiff"

export function activate(context: vscode.ExtensionContext): void {
  const store = new SessionStore()

  const contentProvider = new SemanticStageContentProvider(store)
  const codeLensProvider = new SemanticStageCodeLensProvider(store)
  const decorations = new SemanticStageDecorations(store)
  const clauseNumbers = new ClauseNumberDecorations(store, context.workspaceState)
  const statusBar = new ClauseStatusBar(store)
  const scm = new SemanticSCM(store)

  context.subscriptions.push(
    store,
    decorations,
    clauseNumbers,
    statusBar,
    scm,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider),
    vscode.languages.registerCodeLensProvider({ scheme: SCHEME }, codeLensProvider)
  )

  // Whenever a session rebuilds, refresh every surface that renders it.
  context.subscriptions.push(
    store.onDidRefresh((key) => {
      contentProvider.refresh(key)
      codeLensProvider.refresh()
      // The virtual documents update asynchronously; give them a beat before
      // re-applying decorations.
      setTimeout(() => decorations.refreshAll(), 100)
    })
  )

  // Track whether a semantic-diff editor is active so editor/title buttons
  // can use a reliable when-condition.
  const setDiffContext = (editor: vscode.TextEditor | undefined) => {
    void vscode.commands.executeCommand(
      "setContext",
      "semanticDiff.diffActive",
      editor?.document.uri.scheme === SCHEME
    )
  }
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(setDiffContext))
  setDiffContext(vscode.window.activeTextEditor)

  // Keep sessions in sync with edits to the real file (debounced).
  const debounces = new Map<string, NodeJS.Timeout>()
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file") return
      const filePath = e.document.uri.fsPath

      if (store.get(filePath)) {
        clearTimeout(debounces.get(filePath))
        debounces.set(
          filePath,
          setTimeout(() => {
            debounces.delete(filePath)
            void store.refresh(filePath)
          }, 250)
        )
      }

      // Refresh any book session that includes this chapter file.
      for (const book of store.allBookSessions()) {
        if (book.project.chapters.includes(filePath)) {
          const key = book.rootDir
          clearTimeout(debounces.get(key))
          debounces.set(
            key,
            setTimeout(() => {
              debounces.delete(key)
              void store.refreshBook(key)
            }, 250)
          )
        }
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => decorations.refreshAll())
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("semanticDiff.openDiff", (arg?: unknown) =>
      openSemanticDiff(store, arg)
    ),
    vscode.commands.registerCommand("semanticDiff.stageHunk", () => stageHunkAtCursor(store)),
    vscode.commands.registerCommand("semanticDiff.stageAll", (arg?: unknown) =>
      stageAll(store, arg)
    ),
    vscode.commands.registerCommand("semanticDiff.stageAllFiles", () => stageAllFiles(store)),
    vscode.commands.registerCommand("semanticDiff.nextChange", () => navigateChange(store, 1)),
    vscode.commands.registerCommand("semanticDiff.prevChange", () => navigateChange(store, -1)),
    vscode.commands.registerCommand("semanticDiff.toggleProjection", () =>
      toggleProjection(store)
    ),
    // Internal commands used by CodeLens.
    vscode.commands.registerCommand(
      "semanticDiff.stageClause",
      (filePath: string, changeId: string) => stageClause(store, filePath, changeId)
    ),
    vscode.commands.registerCommand(
      "semanticDiff.ignoreClause",
      (filePath: string, changeId: string) => {
        store.get(filePath)?.setIgnored(changeId, true)
        codeLensProvider.refresh()
        decorations.refreshAll()
      }
    ),
    vscode.commands.registerCommand(
      "semanticDiff.unignoreClause",
      (filePath: string, changeId: string) => {
        store.get(filePath)?.setIgnored(changeId, false)
        codeLensProvider.refresh()
        decorations.refreshAll()
      }
    ),
    vscode.commands.registerCommand("semanticDiff.showRaw", (filePath: string) =>
      showRaw(store, filePath)
    ),
    vscode.commands.registerCommand("semanticDiff.openHistoricalDiff", (arg?: unknown) =>
      openHistoricalDiff(store, arg)
    ),
    vscode.commands.registerCommand("semanticDiff.openBookDiff", () => openBookDiff(store)),
    vscode.commands.registerCommand("semanticDiff.toggleSplitPane", () => toggleSplitPane()),
    vscode.commands.registerCommand("semanticDiff.toggleClauseNumbers", () => {
      const editor = vscode.window.activeTextEditor
      if (!editor || editor.document.uri.scheme !== "file") {
        vscode.window.showWarningMessage("Semantic Diff: open the original file to toggle clause numbers.")
        return
      }
      const filePath = editor.document.uri.fsPath
      clauseNumbers.toggle(filePath)
      vscode.window.setStatusBarMessage(
        clauseNumbers.isEnabled(filePath)
          ? "Semantic Diff: clause numbers on"
          : "Semantic Diff: clause numbers off",
        2500
      )
    }),
    vscode.commands.registerCommand(
      "semanticDiff.stageMove",
      (filePath: string, moveId: string) => stageMove(store, filePath, moveId)
    ),
    vscode.commands.registerCommand(
      "semanticDiff.splitMove",
      (filePath: string, moveId: string) => {
        store.get(filePath)?.splitMove(moveId)
        codeLensProvider.refresh()
        decorations.refreshAll()
      }
    ),
    vscode.commands.registerCommand(
      "semanticDiff.ignoreMove",
      (filePath: string, moveId: string) => {
        store.get(filePath)?.ignoreBothInMove(moveId, true)
        codeLensProvider.refresh()
        decorations.refreshAll()
      }
    ),
    vscode.commands.registerCommand(
      "semanticDiff.unignoreMove",
      (filePath: string, moveId: string) => {
        store.get(filePath)?.ignoreBothInMove(moveId, false)
        codeLensProvider.refresh()
        decorations.refreshAll()
      }
    )
  )
}

export function deactivate(): void {}

function navigateChange(store: SessionStore, direction: 1 | -1): void {
  const editor = vscode.window.activeTextEditor
  if (!editor) return

  const uri = editor.document.uri
  const isVirtual = uri.scheme === SCHEME
  const filePath = isVirtual ? filePathOf(uri) : uri.fsPath
  const session = isVirtual
    ? (store.getByKey(uri.query ? decodeURIComponent(uri.query) : uri.path) ?? store.get(filePath))
    : store.get(filePath)
  if (!session || session.changes.length === 0) return

  if (isVirtual) {
    // In the diff editor: navigate by aligned document line number.
    const currentLine = editor.selection.active.line
    const entries = session.changes
      .map((sc) => ({ sc, line: session.aligned.changeLineMap.get(sc.change.id) ?? -1 }))
      .filter((e) => e.line >= 0)
      .sort((a, b) => a.line - b.line)

    const next = direction === 1
      ? entries.find((e) => e.line > currentLine)
      : [...entries].reverse().find((e) => e.line < currentLine)
    if (!next) return
    const pos = new vscode.Position(next.line, 0)
    editor.selection = new vscode.Selection(pos, pos)
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  } else {
    // In the real file editor: navigate by source offset.
    const proj = session.newProjection
    const currentOffset = editor.document.offsetAt(editor.selection.active)
    const currentClause = clauseAtOffset(proj.lines, currentOffset) ?? -1

    const changeClauseIndices = session.changes
      .map((sc) => sc.change.newStartIndex ?? sc.change.oldStartIndex)
      .filter((idx): idx is number => idx !== null)
      .sort((a, b) => a - b)

    const next = direction === 1
      ? changeClauseIndices.find((idx) => idx > currentClause)
      : [...changeClauseIndices].reverse().find((idx) => idx < currentClause)
    if (next === undefined) return

    const line = proj.lines[next]
    if (!line?.sourceSpan) return
    const pos = editor.document.positionAt(line.sourceSpan.startOffset)
    editor.selection = new vscode.Selection(pos, pos)
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  }
}
