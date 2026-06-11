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
