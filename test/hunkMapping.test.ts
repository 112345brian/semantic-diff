import { test } from "node:test"
import assert from "node:assert/strict"
import { projectDocument } from "../src/projection/projectDocument"
import { analyze } from "../src/diff/hunkMapping"
import { applyEdits } from "../src/git/patchBuilder"
import { AnnotatedChange } from "../src/types/diff"

function analyzeTexts(oldText: string, newText: string): {
  changes: AnnotatedChange[]
  oldText: string
  newText: string
} {
  const oldProj = projectDocument("t.md", oldText)
  const newProj = projectDocument("t.md", newText)
  return { changes: analyze(oldProj, newProj), oldText, newText }
}

function stage(oldText: string, ac: AnnotatedChange): string {
  assert.equal(ac.stageability.kind, "stageable", JSON.stringify(ac))
  if (ac.stageability.kind !== "stageable") throw new Error("unreachable")
  return applyEdits(oldText, [ac.stageability.edit])
}

test("a modified clause stages independently of its neighbors", () => {
  const oldText = "First sentence stays. Second sentence changes here. Third sentence stays.\n"
  const newText = "First sentence stays. Second sentence is rewritten. Third sentence stays.\n"
  const { changes } = analyzeTexts(oldText, newText)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].change.kind, "modified")
  const staged = stage(oldText, changes[0])
  assert.equal(staged, newText)
})

test("two edited clauses are independent: staging one leaves the other unstaged", () => {
  const oldText = "Sentence one is fine. Sentence two needs work. Sentence three needs work too.\n"
  const newText = "Sentence one is fine. Sentence two was fixed. Sentence three was also fixed.\n"
  const { changes } = analyzeTexts(oldText, newText)
  assert.equal(changes.length, 2)
  const staged = stage(oldText, changes[0])
  assert.equal(
    staged,
    "Sentence one is fine. Sentence two was fixed. Sentence three needs work too.\n"
  )
})

test("an inserted sentence stages with its separator", () => {
  const oldText = "We start here. We end here.\n"
  const newText = "We start here. A new thought arrives. We end here.\n"
  const { changes } = analyzeTexts(oldText, newText)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].change.kind, "inserted")
  assert.equal(stage(oldText, changes[0]), newText)
})

test("a deleted mid-paragraph sentence is removed with its separator", () => {
  const oldText = "Keep this one. Drop this one. Keep this too.\n"
  const newText = "Keep this one. Keep this too.\n"
  const { changes } = analyzeTexts(oldText, newText)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].change.kind, "deleted")
  assert.equal(stage(oldText, changes[0]), newText)
})

test("deleting a whole paragraph does not leave doubled blank lines", () => {
  const oldText = "Paragraph one stays.\n\nParagraph two goes away.\n\nParagraph three stays.\n"
  const newText = "Paragraph one stays.\n\nParagraph three stays.\n"
  const { changes } = analyzeTexts(oldText, newText)
  assert.equal(changes.length, 1)
  assert.equal(stage(oldText, changes[0]), newText)
})

test("reflowing a paragraph produces no changes at all", () => {
  const oldText = "The quick brown fox jumps over the lazy dog near the river. It rests.\n"
  const newText = "The quick brown fox jumps over\nthe lazy dog near the river. It\nrests.\n"
  const { changes } = analyzeTexts(oldText, newText)
  assert.equal(changes.length, 0)
})

test("staging a clause from a hard-wrapped paragraph writes real source text, not projected text", () => {
  const oldText = "Alpha beta gamma\ndelta. Second sentence\nhere.\n"
  const newText = "Alpha beta gamma\ndelta. Second sentence\nrevised here.\n"
  const { changes } = analyzeTexts(oldText, newText)
  assert.equal(changes.length, 1)
  const staged = stage(oldText, changes[0])
  // The hard wrap inside the changed clause comes from the working file,
  // not the projection's normalized space.
  assert.equal(staged, newText)
})

test("a clause-boundary shift groups into one change instead of lossy pairs", () => {
  // Adding words pushes the clause over the conjunction threshold, so one old
  // clause becomes two new clauses. Pairing them positionally would stage a
  // truncated sentence; the group keeps it atomic.
  const oldText = "We considered the proposal carefully, but decided to wait.\n"
  const newText =
    "We considered the unusually detailed and ambitious proposal very carefully, but decided to wait.\n"
  const { changes } = analyzeTexts(oldText, newText)
  assert.equal(changes.length, 1)
  const ch = changes[0]
  if (ch.change.grouped) {
    assert.equal(ch.change.kind, "modified")
  }
  assert.equal(stage(oldText, ch), newText)
})

test("modifying a list item stages verbatim", () => {
  const oldText = "- first item\n- second item\n"
  const newText = "- first item\n- second item, improved\n"
  const { changes } = analyzeTexts(oldText, newText)
  assert.equal(changes.length, 1)
  assert.equal(stage(oldText, changes[0]), newText)
})

test("staging all changes reproduces the working text", () => {
  const oldText =
    "# Title\n\nFirst sentence. Second sentence. Third sentence.\n\n- item one\n- item two\n"
  const newText =
    "# New Title\n\nFirst sentence, amended. Second sentence. Third sentence is new.\n\n- item one\n- item two changed\n"
  const { changes } = analyzeTexts(oldText, newText)
  const edits = changes.map((c) => {
    assert.equal(c.stageability.kind, "stageable")
    return (c.stageability as { kind: "stageable"; edit: { oldStart: number; oldEnd: number; newText: string } }).edit
  })
  assert.equal(applyEdits(oldText, edits), newText)
})

test("inserting a whole new paragraph stages with correct separators", () => {
  const oldText = "Paragraph one stays.\n\nParagraph three stays.\n"
  const newText = "Paragraph one stays.\n\nParagraph two is new.\n\nParagraph three stays.\n"
  const { changes } = analyzeTexts(oldText, newText)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].change.kind, "inserted")
  assert.equal(stage(oldText, changes[0]), newText)
})

test("splitting a paragraph in two is a stageable change", () => {
  const oldText = "First thought here. Second thought here.\n"
  const newText = "First thought here.\n\nSecond thought here.\n"
  const { changes } = analyzeTexts(oldText, newText)
  assert.equal(changes.length, 1)
  assert.equal(stage(oldText, changes[0]), newText)
})

test("joining two paragraphs is a stageable change", () => {
  const oldText = "First thought here.\n\nSecond thought here.\n"
  const newText = "First thought here. Second thought here.\n"
  const { changes } = analyzeTexts(oldText, newText)
  assert.equal(changes.length, 1)
  assert.equal(stage(oldText, changes[0]), newText)
})

test("insertion at the top of the file", () => {
  const oldText = "Existing first sentence. And more.\n"
  const newText = "Brand new opener. Existing first sentence. And more.\n"
  const { changes } = analyzeTexts(oldText, newText)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].change.kind, "inserted")
  assert.equal(stage(oldText, changes[0]), newText)
})
