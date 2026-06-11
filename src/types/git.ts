export type RepoContext = {
  /** Absolute path to the repository root. */
  repoRoot: string
  /** Path of the file relative to the repository root, with forward slashes. */
  relPath: string
}
