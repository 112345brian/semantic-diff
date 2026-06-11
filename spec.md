## Project Shape

semantic-stage/
  package.json
  tsconfig.json
  README.md
  src/
    extension.ts
    commands/
      openSemanticDiff.ts
      stageSemanticHunk.ts
      toggleProjection.ts
    projection/
      projectDocument.ts
      semanticBreaks.ts
      sourceMap.ts
    diff/
      clauseDiff.ts
      hunkMapping.ts
    git/
      repository.ts
      blobReader.ts
      patchBuilder.ts
      applyPatch.ts
      stageRanges.ts
    vscode/
      virtualDocumentProvider.ts
      diffView.ts
      codeLensProvider.ts
      decorations.ts
    types/
      projection.ts
      diff.ts
      git.ts
  test/
    projection.test.ts
    sourceMap.test.ts
    hunkMapping.test.ts
    patchBuilder.test.ts
  fixtures/
    simple.md
    paragraph-reflow.md
    citations.md
    markdown-lists.md

## Core Data Model

```ts
export type SourceSpan = {
  startOffset: number
  endOffset: number
}
export type ProjectedToken = {
  text: string
  sourceSpan: SourceSpan | null
  synthetic: boolean
}
export type Projection = {
  filePath: string
  originalText: string
  projectedText: string
  tokens: ProjectedToken[]
}
```

`filePath` belongs on `Projection`, not on every token. All spans within a projection refer to the same file.

Synthetic line breaks are real in the diff view but not real in the file:

```ts
{
  text: "\n",
  sourceSpan: null,
  synthetic: true
}
```

### Clause Change

The diff operates at the clause level. Each changed clause is its own stageable unit — adjacent changed clauses are never merged into a group automatically. This is the key departure from git's proximity-based hunk grouping.

Insertions and deletions are distinct from modifications because one side has no source span:

```ts
export type ClauseChange =
  | { kind: "modified"; oldSpan: SourceSpan; newSpan: SourceSpan }
  | { kind: "inserted"; newSpan: SourceSpan }
  | { kind: "deleted"; oldSpan: SourceSpan }
```

Word-level highlights within a changed clause are cosmetic only — they help the writer read the change but carry no weight in staging decisions.

## Pipeline

Git index blob (not HEAD)
Git working file
      ↓
semantic projection (both sides)
      ↓
clause-level diff
      ↓
one stageable unit per changed clause
      ↓
VS Code virtual diff view
      ↓
approve clause
      ↓
map projected clause → real source span
      ↓
build real patch
      ↓
git apply --cached

The diff basis is **index vs working tree**, not HEAD vs working tree. Diffing against HEAD would produce a patch that conflicts with already-staged content.

## MVP Commands

```json
{
  "contributes": {
    "commands": [
      {
        "command": "semanticStage.openDiff",
        "title": "Semantic Stage: Open Semantic Diff"
      },
      {
        "command": "semanticStage.stageHunk",
        "title": "Semantic Stage: Stage Selected Semantic Hunk"
      },
      {
        "command": "semanticStage.stageAll",
        "title": "Semantic Stage: Stage All Semantic Hunks"
      },
      {
        "command": "semanticStage.toggleProjection",
        "title": "Semantic Stage: Toggle Semantic Projection"
      }
    ]
  }
}
```

`toggleProjection` switches the diff view between semantic projection and raw diff. Useful for verifying that the projection isn't hiding something.

`stageAll` stages only clauses with `kind: "stageable"`. Unsafe clauses are skipped and reported in a summary notification. It does not abort on the first unsafe clause.

## Important Modules

### semanticBreaks.ts

Takes prose and inserts temporary semantic line breaks. Each break defines a clause boundary — and therefore a potential staging unit.

Rules:

- break after sentence-ending punctuation
- break before major coordinating conjunctions (and, but, or, nor, yet, so) when the preceding clause exceeds 60 characters
- preserve code fences
- preserve lists
- preserve blockquotes
- preserve YAML frontmatter
- preserve tables
- preserve citations where possible
- treat inline code spans, bold, and italic as opaque — do not break inside them
- blocks marked as preserved are treated as a single opaque clause token

### sourceMap.ts

Maps projected offsets back to original offsets.

Core functions:

```ts
projectedOffsetToSourceOffset(offset: number): number | null
projectedRangeToSourceRange(start: number, end: number): SourceSpan | null
sourceRangeToProjectedRange(start: number, end: number): {
  start: number
  end: number
}
```

`projectedRangeToSourceRange` returns `null` when the range spans a synthetic break or cannot be cleanly mapped. Callers must handle this — it is the primary safety gate before patch generation.

### clauseDiff.ts

Diffs the projected old and new texts at clause granularity. Produces a sequence of `ClauseChange` values — one per changed clause. Adjacent changed clauses are not merged.

Word-level diff within a changed clause is computed here for display purposes only and is not exposed in the `ClauseChange` type.

### hunkMapping.ts

Determines whether a `ClauseChange` is safely stageable by mapping it through the source map.

```ts
export type Stageability =
  | { kind: "stageable"; change: ClauseChange }
  | { kind: "unsafe"; reason: string }
```

Unsafe examples:

- change touches only a synthetic newline
- projected range spans a synthetic/real boundary ambiguously
- change modifies preserved Markdown structure (fence, table, frontmatter)
- `projectedRangeToSourceRange` returns null for either side

## UI Model

In VS Code diff view:

```text
left: semantic-stage://old/path.md
right: semantic-stage://new/path.md
```

Add CodeLens above each changed clause:

- [Stage clause] [Ignore] [Show raw]

`[Show raw]` opens the file at the corresponding source location in VS Code's native git diff view, so the writer can see the real patch context for that clause.

Use decorations for:

- synthetic line breaks (subtle, distinct from real newlines)
- word-level changes within a clause (cosmetic highlight only)
- unsafe clauses (cannot be staged)
- already-staged clauses (greyed out)

`virtualDocumentProvider.ts` subscribes to `workspace.onDidChangeTextDocument` and invalidates the virtual document for the affected file on each change. The provider reads from the editor buffer, not from disk, so unsaved changes are reflected immediately.

## Git Strategy

Do not write transformed files.

Do not stage projected files.

Only ever stage patches against the real file:

```bash
git apply --cached generated.patch
```

So the extension must produce a normal patch like:

```diff
diff --git a/note.md b/note.md
index ...
--- a/note.md
+++ b/note.md
@@ -14,7 +14,7 @@
-real original line
+real modified line
```

## Development Phases

### V1: View-only

- open semantic projected diff
- clause-level highlights
- word-level cosmetic highlights within changed clauses
- no staging

### V2: Stage whole source-backed clauses

- click "stage clause"
- generate real patch
- git apply --cached

### V3: Safer Markdown awareness

- protect code fences
- protect tables
- protect frontmatter
- protect lists

### V4: Configurable clause granularity

- expose break rules as settings (conjunction threshold, sentence-only mode, etc.)
- let writers tune how aggressively prose is split

## The Key Design Constraint

Never let the projection become authoritative.

The real file is the source of truth.

The semantic-line-break version is only a review surface.
