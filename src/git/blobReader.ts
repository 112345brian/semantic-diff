import { runGit } from "./repository"
import { RepoContext } from "../types/git"

/**
 * Reads the index (staged) version of a file — stage 0 blob. This is the
 * diff basis: index vs working tree, never HEAD, so staging a clause can
 * never conflict with already-staged content.
 *
 * Returns null when the file is not in the index (untracked).
 */
export async function readIndexBlob(repo: RepoContext): Promise<string | null> {
  try {
    const { stdout } = await runGit(repo.repoRoot, ["show", `:0:${repo.relPath}`])
    return stdout
  } catch {
    return null
  }
}

/**
 * Reads the file at a specific git ref (commit hash, branch, tag, HEAD~N, etc.).
 * Returns null when the file did not exist at that ref.
 */
export async function readRefBlob(repo: RepoContext, ref: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(repo.repoRoot, ["show", `${ref}:${repo.relPath}`])
    return stdout
  } catch {
    return null
  }
}

export type CommitInfo = {
  hash: string
  shortHash: string
  subject: string
  date: string
  author: string
}

/** Returns the N most recent commits that touched the given file. */
export async function recentCommits(repo: RepoContext, n = 30): Promise<CommitInfo[]> {
  try {
    const sep = "\x1f"
    const { stdout } = await runGit(repo.repoRoot, [
      "log",
      `--max-count=${n}`,
      `--format=%H${sep}%h${sep}%s${sep}%ad${sep}%an`,
      "--date=short",
      "--",
      repo.relPath,
    ])
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, shortHash, subject, date, author] = line.split(sep)
        return { hash, shortHash, subject, date, author }
      })
  } catch {
    return []
  }
}
