import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "fs"
import * as path from "path"
import { projectDocument } from "../src/projection/projectDocument"
import { splitClauses } from "../src/projection/semanticBreaks"

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, "..", "..", "fixtures", name), "utf8")

test("splits sentences into clauses", () => {
  const text = "First sentence here. Second one follows! Third asks?"
  const spans = splitClauses(text)
  assert.equal(spans.length, 3)
  assert.equal(text.slice(spans[0].start, spans[0].end), "First sentence here.")
  assert.equal(text.slice(spans[1].start, spans[1].end), "Second one follows!")
  assert.equal(text.slice(spans[2].start, spans[2].end), "Third asks?")
})

test("does not break after common abbreviations", () => {
  const text = "The result, e.g. the mean, was high. Dr. Smith agreed."
  const spans = splitClauses(text)
  assert.equal(spans.length, 2)
  assert.equal(text.slice(spans[0].start, spans[0].end), "The result, e.g. the mean, was high.")
})

test("does not break inside citation brackets", () => {
  const text = "Prior work established this [@doe2020, p. 4]. Later work confirmed it."
  const spans = splitClauses(text)
  assert.equal(spans.length, 2)
  assert.ok(text.slice(spans[0].start, spans[0].end).includes("[@doe2020, p. 4]"))
})

test("breaks before no-comma conjunction when followed by a subject pronoun", () => {
  const sentence =
    "I was driving down from the highways onto the trails and into the valley and the whole time I never seen a car coming my direction."
  const spans = splitClauses(sentence, 60)
  assert.equal(spans.length, 2)
  // First clause ends before "and the whole time"
  assert.ok(sentence.slice(spans[0].start, spans[0].end).includes("into the valley"))
  // Second clause starts with the conjunction
  assert.ok(sentence.slice(spans[1].start, spans[1].end).startsWith("and the whole time"))
})

test("does not break 'X and Y' noun/prepositional phrases", () => {
  // "and into the valley" is a prepositional phrase, not a new clause — no pronoun follows
  const sentence = "I went down the trail and into the valley."
  assert.equal(splitClauses(sentence, 20).length, 1)
})

test("breaks before coordinating conjunction only when the clause is long", () => {
  const long =
    "The committee deliberated for several hours about the unusual proposal, but ultimately it decided to wait."
  const spans = splitClauses(long, 60)
  assert.equal(spans.length, 2)
  assert.ok(long.slice(spans[1].start, spans[1].end).startsWith("but"))

  const short = "We met, but we waited."
  assert.equal(splitClauses(short, 60).length, 1)
})

test("projection: each clause becomes a line ending in a synthetic break", () => {
  const proj = projectDocument("simple.md", fixture("simple.md"))
  const proseLines = proj.lines.filter((l) => l.kind === "prose")
  assert.equal(proseLines.length, 4) // 3 clauses + 1 short paragraph
  assert.ok(proseLines[0].syntheticEol)
  assert.ok(proseLines[1].syntheticEol)
  assert.ok(!proseLines[2].syntheticEol) // last clause of the paragraph: real newline
})

test("projection is reflow-resistant: rewrapping a paragraph changes nothing", () => {
  const wrapped = fixture("paragraph-reflow.md")
  const unwrapped = wrapped.replace(/\n(?!$)/g, " ")
  const a = projectDocument("a.md", wrapped)
  const b = projectDocument("b.md", unwrapped)
  assert.equal(a.projectedText, b.projectedText)
})

test("markdown structure is preserved verbatim", () => {
  const text = fixture("markdown-lists.md")
  const proj = projectDocument("markdown-lists.md", text)
  // No synthetic break may appear inside frontmatter, lists, fences, tables,
  // or quotes: every verbatim line ends with a real newline.
  for (const line of proj.lines) {
    if (line.kind === "verbatim") assert.ok(!line.syntheticEol, `unexpected break in: ${line.text}`)
  }
  // A list item with sentence punctuation stays one line.
  const listLine = proj.lines.find((l) => l.text.includes("first item"))
  assert.ok(listLine)
  assert.equal(listLine!.text, "- first item stays one line. even with punctuation.")
  // Code fence content untouched.
  assert.ok(proj.lines.some((l) => l.text === "const x = 1. plus more."))
})

test("every projected character is either sourced or a synthetic newline", () => {
  const text = fixture("citations.md")
  const proj = projectDocument("citations.md", text)
  for (const tok of proj.tokens) {
    if (tok.synthetic) {
      assert.equal(tok.text, "\n")
      assert.equal(tok.sourceSpan, null)
    } else {
      assert.ok(tok.sourceSpan, `unsourced token: ${JSON.stringify(tok.text)}`)
    }
  }
})

test("non-synthetic, non-replacement tokens reproduce their source text exactly", () => {
  const text = fixture("simple.md")
  const proj = projectDocument("simple.md", text)
  for (const tok of proj.tokens) {
    if (tok.synthetic || !tok.sourceSpan) continue
    const src = text.slice(tok.sourceSpan.startOffset, tok.sourceSpan.endOffset)
    if (tok.text === " ") continue // replacement separator may differ
    assert.equal(tok.text, src)
  }
})
