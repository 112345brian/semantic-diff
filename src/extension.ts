import * as vscode from "vscode"
import { SessionStore } from "./vscode/sessionStore"
import {
  SemanticStageContentProvider,
  SCHEME,
} from "./vscode/virtualDocumentProvider"
import { SemanticStageCodeLensProvider } from "./vscode/codeLensProvider"
import { SemanticStageDecorations } from "./vscode/decorations"
import { openSemanticDiff } from "./commands/openSemanticDiff"
import {
  stageClause,
  stageHunkAtCursor,
  stageAll,
  showRaw,
} from "./commands/stageSemanticHunk"
import { toggleProjection } from "./commands/toggleProjection"

export function activate(context: vscode.ExtensionContext): void {
  const store = new SessionStore()
  const getSession = (filePath: string) => store.get(filePath)

  const contentProvider = new SemanticStageContentProvider(getSession)
  const codeLensProvider = new SemanticStageCodeLensProvider(getSession)
  const decorations = new SemanticStageDecorations(getSession)

  context.subscriptions.push(
    store,
    decorations,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider),
    vscode.languages.registerCodeLensProvider({ scheme: SCHEME }, codeLensProvider)
  )

  // Whenever a session rebuilds, refresh every surface that renders it.
  context.subscriptions.push(
    store.onDidRefresh((filePath) => {
      contentProvider.refresh(filePath)
      codeLensProvider.refresh()
      // The virtual documents update asynchronously; give them a beat before
      // re-applying decorations.
      setTimeout(() => decorations.refreshAll(), 100)
    })
  )

  // Keep sessions in sync with edits to the real file (debounced).
  const debounces = new Map<string, NodeJS.Timeout>()
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file") return
      const filePath = e.document.uri.fsPath
      if (!store.get(filePath)) return
      clearTimeout(debounces.get(filePath))
      debounces.set(
        filePath,
        setTimeout(() => {
          debounces.delete(filePath)
          void store.refresh(filePath)
        }, 250)
      )
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => decorations.refreshAll())
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("semanticStage.openDiff", (arg?: unknown) =>
      openSemanticDiff(store, arg)
    ),
    vscode.commands.registerCommand("semanticStage.stageHunk", () => stageHunkAtCursor(store)),
    vscode.commands.registerCommand("semanticStage.stageAll", (arg?: unknown) =>
      stageAll(store, arg)
    ),
    vscode.commands.registerCommand("semanticStage.toggleProjection", () =>
      toggleProjection(store)
    ),
    // Internal commands used by CodeLens.
    vscode.commands.registerCommand(
      "semanticStage.stageClause",
      (filePath: string, changeId: string) => stageClause(store, filePath, changeId)
    ),
    vscode.commands.registerCommand(
      "semanticStage.ignoreClause",
      (filePath: string, changeId: string) => {
        store.get(filePath)?.setIgnored(changeId, true)
        codeLensProvider.refresh()
        decorations.refreshAll()
      }
    ),
    vscode.commands.registerCommand(
      "semanticStage.unignoreClause",
      (filePath: string, changeId: string) => {
        store.get(filePath)?.setIgnored(changeId, false)
        codeLensProvider.refresh()
        decorations.refreshAll()
      }
    ),
    vscode.commands.registerCommand("semanticStage.showRaw", (filePath: string) =>
      showRaw(store, filePath)
    )
  )
}

export function deactivate(): void {}
