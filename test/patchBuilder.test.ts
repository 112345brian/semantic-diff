import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildPatch, applyEdits } from "../src/git/patchBuilder"

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" })
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "semstage-test-"))
  git(dir, "init", "-q")
  git(dir, "config", "user.email", "test@example.com")
  git(dir, "config", "user.name", "Test")
  return dir
}

/** Stages a patch in a real repo and returns the resulting index content. */
function stageAndReadIndex(repoDir: string, relPath: string, patch: string): string {
  const patchFile = path.join(repoDir, ".tmp.patch")
  fs.writeFileSync(patchFile, patch)
  git(repoDir, "apply", "--cached", patchFile)
  fs.unlinkSync(patchFile)
  return git(repoDir, "show", `:0:${relPath}`)
}

test("a generated patch applies cleanly with git apply --cached", () => {
  const repo = makeRepo()
  const oldText = "line one\nline two\nline three\nline four\nline five\n"
  const newText = "line one\nline two changed\nline three\nline four\nline five\n"
  fs.writeFileSync(path.join(repo, "note.md"), oldText)
  git(repo, "add", "note.md")
  git(repo, "commit", "-qm", "init")
  fs.writeFileSync(path.join(repo, "note.md"), newText)

  const patch = buildPatch("note.md", oldText, newText)
  assert.ok(patch)
  assert.equal(stageAndReadIndex(repo, "note.md", patch!), newText)
})

test("patch for an insertion-only change", () => {
  const repo = makeRepo()
  const oldText = "alpha\nbeta\n"
  const newText = "alpha\ninserted\nbeta\n"
  fs.writeFileSync(path.join(repo, "f.md"), oldText)
  git(repo, "add", "f.md")
  const patch = buildPatch("f.md", oldText, newText)
  assert.ok(patch)
  assert.equal(stageAndReadIndex(repo, "f.md", patch!), newText)
})

test("patch for a file without trailing newline", () => {
  const repo = makeRepo()
  const oldText = "alpha\nbeta"
  const newText = "alpha\ngamma"
  fs.writeFileSync(path.join(repo, "f.md"), oldText)
  git(repo, "add", "f.md")
  const patch = buildPatch("f.md", oldText, newText)
  assert.ok(patch)
  assert.equal(stageAndReadIndex(repo, "f.md", patch!), newText)
})

test("patch that removes the trailing newline", () => {
  const repo = makeRepo()
  const oldText = "alpha\nbeta\n"
  const newText = "alpha\nbeta"
  fs.writeFileSync(path.join(repo, "f.md"), oldText)
  git(repo, "add", "f.md")
  const patch = buildPatch("f.md", oldText, newText)
  assert.ok(patch)
  assert.equal(stageAndReadIndex(repo, "f.md", patch!), newText)
})

test("new-file patch for an untracked file", () => {
  const repo = makeRepo()
  // Need at least one commit-free index operation; untracked file case.
  const newText = "brand new file\nsecond line\n"
  fs.writeFileSync(path.join(repo, "new.md"), newText)
  const patch = buildPatch("new.md", "", newText, { isNew: true })
  assert.ok(patch)
  assert.equal(stageAndReadIndex(repo, "new.md", patch!), newText)
})

test("identical texts produce no patch", () => {
  assert.equal(buildPatch("f.md", "same\n", "same\n"), null)
})

test("multiple distant edits produce a multi-hunk patch that applies", () => {
  const repo = makeRepo()
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
  const oldText = lines.join("\n") + "\n"
  const newLines = [...lines]
  newLines[2] = "line 3 changed"
  newLines[25] = "line 26 changed"
  const newText = newLines.join("\n") + "\n"
  fs.writeFileSync(path.join(repo, "f.md"), oldText)
  git(repo, "add", "f.md")
  const patch = buildPatch("f.md", oldText, newText)
  assert.ok(patch)
  assert.equal((patch!.match(/^@@ /gm) ?? []).length, 2)
  assert.equal(stageAndReadIndex(repo, "f.md", patch!), newText)
})

test("applyEdits rejects overlapping edits", () => {
  assert.throws(() =>
    applyEdits("abcdef", [
      { oldStart: 0, oldEnd: 3, newText: "x" },
      { oldStart: 2, oldEnd: 5, newText: "y" },
    ])
  )
})

test("applyEdits keeps same-position insertions in input order", () => {
  const result = applyEdits("ab", [
    { oldStart: 1, oldEnd: 1, newText: "X" },
    { oldStart: 1, oldEnd: 1, newText: "Y" },
  ])
  assert.equal(result, "aXYb")
})
