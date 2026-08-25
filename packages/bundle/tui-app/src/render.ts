/**
 * Terminal presentation for the TUI app: colors, tool-call summaries, and
 * bounded previews. Pure formatting — nothing here touches the Agent, the
 * Session, or the process.
 * @module @deepseek-ai/dsh-tui-app/render
 */

/** SGR wrappers, disabled when the stream is not a TTY or NO_COLOR is set. */
export interface Palette {
  dim(s: string): string
  bold(s: string): string
  cyan(s: string): string
  green(s: string): string
  yellow(s: string): string
  red(s: string): string
}

const IDENTITY = (s: string): string => s

/** Built rather than written literally so no raw control byte enters this source. */
const ESC = String.fromCharCode(27)

/**
 * Build a palette for one output stream.
 * @param color - whether to emit SGR escapes at all.
 * @returns wrappers that either colorize or pass through unchanged.
 */
export function palette(color: boolean): Palette {
  if (!color) {
    return { dim: IDENTITY, bold: IDENTITY, cyan: IDENTITY, green: IDENTITY, yellow: IDENTITY, red: IDENTITY }
  }
  const wrap = (open: string) => (s: string): string => `${ESC}[${open}m${s}${ESC}[0m`
  return {
    dim: wrap('2'),
    bold: wrap('1'),
    cyan: wrap('36'),
    green: wrap('32'),
    yellow: wrap('33'),
    red: wrap('31'),
  }
}

/** Clear the screen and home the cursor; used by the `/clear` command. */
export function clearScreen(): string {
  return `${ESC}[2J${ESC}[H`
}

/** Longest single-line preview rendered for a tool argument or result. */
const PREVIEW_CHARS = 160

/**
 * Collapse text to one bounded single line for an inline preview.
 * @param text - arbitrary, possibly multi-line, possibly huge text.
 * @param limit - maximum characters to keep before the ellipsis.
 * @returns a single line no longer than `limit` plus the ellipsis marker.
 */
export function preview(text: string, limit: number = PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * Summarize a tool call's arguments for the one-line call banner. Well-known
 * argument shapes get the field that identifies the action; anything else
 * falls back to a bounded preview of the raw JSON.
 * @param args - the raw JSON argument string as logged.
 * @returns a short human-readable summary, possibly empty.
 */
export function summarizeArgs(args: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return preview(args, 80)
  }
  if (typeof parsed !== 'object' || parsed === null) return preview(args, 80)
  const record = parsed as Record<string, unknown>
  // Order matters: the first present key is the one that identifies the action.
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'prompt', 'description']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return preview(value, 100)
  }
  return preview(args, 80)
}
