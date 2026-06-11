import * as vscode from "vscode"
import * as path from "path"
import { SessionStore } from "../vscode/sessionStore"
import { oldUri, newUri } from "../vscode/virtualDocumentProvider"
import { resolveRepo } from "../git/repository"
import { recentCommits, CommitInfo } from "../git/blobReader"
import { resolveTargetFile, ensureDiffSettings } from "./openSemanticDiff"

/**
 * Opens a read-only semantic diff between two historical git refs for the
 * active file.
 *
 * Flow:
 *  1. Pick the "old" (earlier) commit from a list of recent commits.
 *  2. Pick the "new" (later) commit — defaults to the commit immediately
 *     after the one chosen in step 1, but can be any ref.
 */
export async function openHistoricalDiff(store: SessionStore, arg?: unknown): Promise<void> {
  const filePath = resolveTargetFile(arg)
  if (!filePath) {
    vscode.window.showWarningMessage("Semantic Diff: open a file first.")
    return
  }

  const repo = await resolveRepo(filePath)
  if (!repo) {
    vscode.window.showErrorMessage("Semantic Diff: this file is not inside a git repository.")
    return
  }

  const commits = await recentCommits(repo, 60)
  if (commits.length === 0) {
    vscode.window.showWarningMessage("Semantic Diff: no commits found for this file.")
    return
  }

  // Step 1: pick the old (earlier / left) side.
  const oldPick = await pickCommit(commits, `Select the OLD (earlier) commit — ${path.basename(filePath)}`)
  if (!oldPick) return

  // Step 2: pick the new (later / right) side. Pre-select the commit that
  // follows the old pick so the default pair is a single-commit diff.
  const oldIdx = commits.findIndex((c) => c.hash === oldPick.hash)
  const suggestedNewIdx = oldIdx > 0 ? oldIdx - 1 : 0
  const newPick = await pickCommit(
    commits,
    `Select the NEW (later) commit — ${path.basename(filePath)}`,
    suggestedNewIdx,
    oldPick
  )
  if (!newPick) return

  try {
    const [, key] = await store.getOrCreateHistorical(filePath, oldPick.hash, newPick.hash)
    await ensureDiffSettings()
    const title = `${path.basename(filePath)}  ${oldPick.shortHash} ↔ ${newPick.shortHash}`
    await vscode.commands.executeCommand(
      "vscode.diff",
      oldUri(filePath, key),
      newUri(filePath, key),
      title
    )
  } catch (err: any) {
    vscode.window.showErrorMessage(`Semantic Diff: ${err.message ?? err}`)
  }
}

async function pickCommit(
  commits: CommitInfo[],
  title: string,
  activeIndex = 0,
  exclude?: CommitInfo
): Promise<CommitInfo | undefined> {
  type Item = vscode.QuickPickItem & { commit: CommitInfo }

  const items: Item[] = commits
    .filter((c) => c.hash !== exclude?.hash)
    .map((c) => ({
      label: `$(git-commit) ${c.shortHash}`,
      description: c.subject,
      detail: `${c.date}  ·  ${c.author}`,
      commit: c,
    }))

  // Also offer HEAD and common relative refs at the top.
  const builtins: Item[] = [
    {
      label: "$(tag) HEAD",
      description: "current commit (tip of branch)",
      detail: "",
      commit: { hash: "HEAD", shortHash: "HEAD", subject: "current commit", date: "", author: "" },
    },
  ]

  const qp = vscode.window.createQuickPick<Item>()
  qp.title = title
  qp.placeholder = "Select a commit or type any ref (branch, tag, HEAD~3, …)"
  qp.items = [...builtins, ...items]
  qp.activeItems = [qp.items[Math.min(activeIndex + builtins.length, qp.items.length - 1)]]
  qp.matchOnDescription = true
  qp.matchOnDetail = true

  return new Promise((resolve) => {
    qp.onDidAccept(() => {
      const selected = qp.selectedItems[0]
      if (selected) {
        resolve(selected.commit)
      } else if (qp.value.trim()) {
        // User typed a custom ref.
        const ref = qp.value.trim()
        resolve({ hash: ref, shortHash: ref, subject: ref, date: "", author: "" })
      } else {
        resolve(undefined)
      }
      qp.dispose()
    })
    qp.onDidHide(() => {
      resolve(undefined)
      qp.dispose()
    })
    qp.show()
  })
}
