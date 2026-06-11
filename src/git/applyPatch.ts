import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { runGit } from "./repository"
import { RepoContext } from "../types/git"

/**
 * Applies a patch to the index only (`git apply --cached`). The working tree
 * is never touched — the real file stays exactly as the writer left it.
 */
export async function applyCachedPatch(repo: RepoContext, patch: string): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "semantic-diff-"))
  const patchFile = path.join(tmpDir, "staged.patch")
  try {
    await fs.writeFile(patchFile, patch, "utf8")
    await runGit(repo.repoRoot, ["apply", "--cached", "--whitespace=nowarn", patchFile])
  } catch (err: any) {
    const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : ""
    throw new Error(`git apply --cached failed${stderr ? `: ${stderr}` : ""}`)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}
