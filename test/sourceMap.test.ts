import { test } from "node:test"
import assert from "node:assert/strict"
import { projectDocument } from "../src/projection/projectDocument"
import { SourceMap } from "../src/projection/sourceMap"

const TEXT = "Alpha beta gamma. Delta epsilon zeta.\n"

test("projected offsets map back to source offsets", () => {
  const proj = projectDocument("t.md", TEXT)
  const map = new SourceMap(proj.tokens)
  // First clause occupies projected line 0 and source offsets 0..17.
  assert.equal(map.projectedOffsetToSourceOffset(0), 0)
  assert.equal(map.projectedOffsetToSourceOffset(5), 5)
})

test("synthetic newline maps to null", () => {
  const proj = projectDocument("t.md", TEXT)
  const map = new SourceMap(proj.tokens)
  const clauseEnd = proj.lines[0].projEnd // the synthetic "\n" sits here
  assert.ok(proj.lines[0].syntheticEol)
  assert.equal(map.projectedOffsetToSourceOffset(clauseEnd), null)
})

test("range mapping round-trips a clause", () => {
  const proj = projectDocument("t.md", TEXT)
  const map = new SourceMap(proj.tokens)
  const line = proj.lines[1] // "Delta epsilon zeta."
  const span = map.projectedRangeToSourceRange(line.projStart, line.projEnd)
  assert.ok(span)
  assert.equal(TEXT.slice(span!.startOffset, span!.endOffset), "Delta epsilon zeta.")
})

test("range crossing a synthetic break returns null", () => {
  const proj = projectDocument("t.md", TEXT)
  const map = new SourceMap(proj.tokens)
  const line0 = proj.lines[0]
  // End lands exactly on the synthetic newline character.
  const span = map.projectedRangeToSourceRange(line0.projStart, line0.projEnd + 1)
  assert.equal(span, null)
})

test("source range maps to a projected range covering it", () => {
  const proj = projectDocument("t.md", TEXT)
  const map = new SourceMap(proj.tokens)
  const srcStart = TEXT.indexOf("Delta")
  const srcEnd = srcStart + "Delta".length
  const r = map.sourceRangeToProjectedRange(srcStart, srcEnd)
  assert.equal(proj.projectedText.slice(r.start, r.end), "Delta")
})

test("hard-wrapped clause maps through replacement separators", () => {
  const wrapped = "Alpha beta\ngamma delta epsilon.\n"
  const proj = projectDocument("t.md", wrapped)
  const map = new SourceMap(proj.tokens)
  const line = proj.lines[0]
  assert.equal(line.text, "Alpha beta gamma delta epsilon.")
  const span = map.projectedRangeToSourceRange(line.projStart, line.projEnd)
  assert.ok(span)
  assert.equal(wrapped.slice(span!.startOffset, span!.endOffset), "Alpha beta\ngamma delta epsilon.")
})
