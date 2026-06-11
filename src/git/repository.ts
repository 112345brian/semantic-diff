import { execFile } from "child_process"
import * as path from "path"
import { RepoContext } from "../types/git"

export function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr }))
        else resolve({ stdout, stderr })
      }
    )
  })
}

/**
 * Resolves the repository root and repo-relative path for a file.
 * Returns null when the file is not inside a git repository.
 */
export async function resolveRepo(filePath: string): Promise<RepoContext | null> {
  try {
    const dir = path.dirname(filePath)
    const { stdout } = await runGit(dir, ["rev-parse", "--show-toplevel"])
    const repoRoot = stdout.trim()
    if (!repoRoot) return null
    const relPath = path.relative(repoRoot, filePath).split(path.sep).join("/")
    if (relPath.startsWith("..")) return null
    return { repoRoot, relPath }
  } catch {
    return null
  }
}
