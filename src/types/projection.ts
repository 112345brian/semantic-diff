export type SourceSpan = {
  startOffset: number
  endOffset: number
}

export type ProjectedToken = {
  text: string
  sourceSpan: SourceSpan | null
  synthetic: boolean
}

export type ProjectedLineKind = "prose" | "verbatim" | "blank"

/**
 * One line of the projected text. In the projection every clause is its own
 * line, so a ProjectedLine is the unit of diffing and staging.
 */
export type ProjectedLine = {
  text: string
  /** Offset of the first character of the line in the projected text. */
  projStart: number
  /** Offset just past the last character of the line (excludes the newline). */
  projEnd: number
  /**
   * The region of the original file this line's content came from. Excludes
   * the line's own newline. Blank lines carry an empty span at their source
   * position so they can serve as anchors. Null only when nothing on the line
   * maps to source text.
   */
  sourceSpan: SourceSpan | null
  /** True when the newline ending this line was inserted by the projection. */
  syntheticEol: boolean
  kind: ProjectedLineKind
}

export type Projection = {
  filePath: string
  originalText: string
  projectedText: string
  tokens: ProjectedToken[]
  lines: ProjectedLine[]
}
