/**
 * The TUI app's command-line provider: it parses this app's flags and
 * publishes {@link TUI_STARTUP_SERVICE}. The runner is an ordinary consumer
 * whose lazy config waits for that service.
 * @module @deepseek-ai/dsh-tui-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the TUI runner. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** What the runner row reads from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** Session id to resume, when this invocation asked for one. */
  resume: string | undefined
}

/**
 * This app's command: its flags, description, and help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Interactive terminal session: stream a coding agent in the terminal.')
    .helpOption('-h, --help', 'show this help')
    .option('--resume <id>', 'resume a persisted session by id instead of starting a fresh one')
    .addHelpText('after', `
Examples:
  dsh --profile tui                 start a fresh interactive session
  dsh --profile tui --resume <id>   continue a persisted session

In-session commands:
  /exit, /quit    leave (Ctrl-D does the same)
  /clear          clear the terminal transcript (the session log is untouched)
  /id             print this session's id, for a later --resume
  Ctrl-C          cancel the turn in flight; again at an empty prompt exits
`)
}

/**
 * Parse and provide this app's startup values as an ordinary Cordis service.
 * On `--help` the command exits before the action runs, so nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const opts = program.opts<{ resume?: string }>()
    const resume = opts.resume?.trim()
    ctx.provide(TUI_STARTUP_SERVICE, {
      resume: resume === undefined || resume === '' ? undefined : resume,
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
