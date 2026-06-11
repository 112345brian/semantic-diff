# Semantic Stage

A VS Code extension for reviewing and staging prose changes in git at **clause granularity**. For a writer, the meaningful unit of change is the clause — a rephrased argument, a softened claim, a dropped qualifier — not the line. Semantic Stage projects prose onto a clause-per-line review surface, diffs it there, and lets you stage each clause change independently.

## How it works

```
git index blob          working file
        \                  /
      semantic projection (clause per line)
                 |
        clause-level diff
                 |
   one stageable unit per changed clause
                 |
      VS Code virtual diff view (CodeLens per clause)
                 |
        approve a clause
                 |
   map back to real source ranges
                 |
     unified diff against the real file
                 |
        git apply --cached
```

Key properties:

- **The projection is never authoritative.** The real file is the source of truth. Staged replacement text is always sliced from the real working file — never from the projection — so normalized whitespace and synthetic breaks can never leak into the repository.
- **Diff basis is index vs working tree** (not HEAD), so staging a clause never conflicts with already-staged content, and staged clauses naturally disappear from the diff.
- **Reflow-resistant.** Hard wraps inside a clause are normalized to spaces in the projection (with exact source mapping), so rewrapping a paragraph produces no diff at all.
- **Markdown-aware.** Frontmatter, code fences, tables, lists, blockquotes, and headings pass through verbatim, one source line per projected line. Clause breaking never fires inside inline code or `[@citations]`.
- **The working tree is never modified.** Only `git apply --cached` is ever run.

## Commands

| Command | What it does |
| --- | --- |
| `Semantic Stage: Open Semantic Diff` | Opens the clause-projected diff (index ↔ working tree) for the active file. |
| `Semantic Stage: Stage Selected Semantic Hunk` | Stages the clause under the cursor in the diff view. |
| `Semantic Stage: Stage All Semantic Hunks` | Stages every safe clause change; skips and reports unsafe ones. |
| `Semantic Stage: Toggle Semantic Projection` | Flips the diff between projection and raw text. |

Each changed clause also gets a CodeLens row: **Stage clause** / **Ignore** / **Show raw** (opens the native git diff).

## Clause rules

- Break after sentence-ending punctuation (`.` `!` `?` `…`), keeping closing quotes/brackets with the sentence; abbreviations (`e.g.`, `Dr.`, `et al.`, initials) don't break.
- Break before a coordinating conjunction following a comma when the clause so far is ≥ 60 characters (`semanticStage.conjunctionMinLength`).
- Never break inside inline code, brackets, or parentheses.

## Safety model

A clause change is **stageable** only when it maps cleanly to real source ranges. When clause boundaries shift (an edit splits one clause into two), positional pairing would stage truncated text — those runs are detected and grouped into one atomic unit instead. Insertions and deletions of whole paragraphs mirror the working file's separators exactly via gap replacement. Anything that can't be mapped is marked **unsafe** with a reason and a "Show raw" escape hatch; `Stage All` skips unsafe changes and reports the count.

## Development

```bash
npm install
npm test        # compiles and runs the pure-logic test suite (node:test)
```

Launch the extension with F5 in VS Code (Run Extension).

The core pipeline (`projection/`, `diff/`, `git/patchBuilder.ts`) is pure and fully tested without VS Code, including tests that build patches and apply them with real `git apply --cached` in throwaway repositories.

### Deviations from spec.md

- `tokenization.ts` / `wordDiff.ts` / `hunkBuilder.ts` don't exist: tokenization is inseparable from break insertion, word-level highlights come free from VS Code's native diff renderer, and there is no hunk grouping (one clause = one unit).
- `stageRanges.ts` / `diffView.ts` were folded into `patchBuilder.ts` and the `openSemanticDiff` command respectively.
- Changes inside preserved Markdown blocks (fences, tables, lists) are stageable as verbatim whole-line edits rather than rejected as unsafe — the projection there is the identity, so the mapping is exact and rejecting them would only force writers to the raw view.
- Clause-boundary-shift runs are staged as one grouped unit (see Safety model) rather than rejected.
