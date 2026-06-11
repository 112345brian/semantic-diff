import * as path from "path"
import * as fs from "fs/promises"

export type BookProject = {
  kind: "bookdown" | "quarto"
  rootDir: string
  /** Chapter file paths in render order, absolute. */
  chapters: string[]
}

/**
 * Walks up from `startDir` looking for _bookdown.yml or _quarto.yml.
 * Returns the first project found, or null.
 */
export async function detectBookProject(startDir: string): Promise<BookProject | null> {
  let dir = startDir
  for (let depth = 0; depth < 6; depth++) {
    const bookdown = await tryReadFile(path.join(dir, "_bookdown.yml"))
    if (bookdown !== null) {
      const chapters = parseBookdownChapters(bookdown, dir)
      if (chapters.length > 0) return { kind: "bookdown", rootDir: dir, chapters }
    }

    const quarto = await tryReadFile(path.join(dir, "_quarto.yml"))
    if (quarto !== null) {
      const chapters = parseQuartoChapters(quarto, dir)
      if (chapters.length > 0) return { kind: "quarto", rootDir: dir, chapters }
    }

    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

async function tryReadFile(p: string): Promise<string | null> {
  try { return await fs.readFile(p, "utf8") } catch { return null }
}

function parseBookdownChapters(yaml: string, rootDir: string): string[] {
  const files: string[] = []
  const lines = yaml.split("\n")
  let inList = false
  for (const line of lines) {
    if (/^rmd_files\s*:/.test(line)) { inList = true; continue }
    if (inList) {
      const item = line.match(/^\s+-\s+"?([^"]+)"?\s*$/)
      if (item) { files.push(path.join(rootDir, item[1].trim())); continue }
      if (line.trim() && !line.startsWith(" ")) break
    }
  }
  // If no explicit list, default to all .Rmd files alphabetically (bookdown default).
  if (files.length === 0) return []
  return files
}

function parseQuartoChapters(yaml: string, rootDir: string): string[] {
  const files: string[] = []
  const lines = yaml.split("\n")
  let inBook = false
  let inChapters = false
  let bookIndent = 0
  let chapterIndent = 0

  for (const line of lines) {
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0
    const trimmed = line.trim()

    if (!inBook) {
      if (trimmed === "book:") { inBook = true; bookIndent = indent; continue }
      continue
    }

    // Left the book block
    if (trimmed && indent <= bookIndent && trimmed !== "book:") { inBook = false; continue }

    if (!inChapters) {
      if (/^chapters\s*:/.test(trimmed)) { inChapters = true; chapterIndent = indent; continue }
      continue
    }

    // Left the chapters list
    if (trimmed && indent <= chapterIndent && !/^-\s/.test(trimmed)) { inChapters = false; continue }

    const item = line.match(/^\s+-\s+"?([^"#][^"]*?)"?\s*$/)
    if (item) files.push(path.join(rootDir, item[1].trim()))
  }
  return files
}
