/**
 * `@deepseek-ai/dsh-tui-app` — interactive terminal driver. The bundle patch
 * rides over dsh-base without Host, HTTP, or browser plugins; this runner
 * creates one Agent through the core registry, mirrors its session log to the
 * terminal as it streams, answers approval questions at the keyboard, and
 * reads the next prompt when the Agent goes idle.
 *
 * The renderer is deliberately thin: it subscribes to `session/event` and
 * formats what it receives. Approval policy, compaction, persistence, and tool
 * execution all stay where dsh-base put them.
 *
 * @module @deepseek-ai/dsh-tui-app
 */

import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import type { Interface as ReadlineInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { clearScreen, palette, preview, summarizeArgs } from './render.ts'
import type { Palette } from './render.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the interactive loop can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Plugin config, resolved from this app's injected startup provider. */
export interface Config {
  /** Session id to resume, when the invocation asked for one. */
  resume?: string
}

export const Config: z<Config> = z.object({
  resume: z.string(),
})

/** Process-facing effects: the streams the renderer writes to and the launcher's exit request. */
interface TuiIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/** The process streams the runner writes to; tests substitute captures. */
export const internals: { stdout: TuiIo['stdout']; stderr: TuiIo['stderr'] } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/**
 * Append-only terminal transcript of one session.
 *
 * The renderer tracks just enough state to avoid ugly output: whether the
 * current line is mid-stream (so a tool banner can break the line first) and
 * which tool calls are still awaiting results (so a result can name its call).
 */
class Transcript {
  /** True while assistant text has been written without a closing newline. */
  private open = false
  /** Tool name by call id, so a `tool/result` can name the call it answers. */
  private readonly pending = new Map<string, string>()

  constructor(private readonly io: TuiIo, private readonly p: Palette) {}

  /** Close any half-written stream line so a banner starts at column zero. */
  private breakLine(): void {
    if (!this.open) return
    this.io.stdout.write('\n')
    this.open = false
  }

  /** Write a standalone line, breaking a streaming line first. */
  line(text: string): void {
    this.breakLine()
    this.io.stdout.write(`${text}\n`)
  }

  /** Append streamed assistant text without a trailing newline. */
  delta(text: string): void {
    if (text === '') return
    this.io.stdout.write(text)
    this.open = true
  }

  /** Render one session event. Unknown and log-only events are ignored. */
  render(event: SessionEvent): void {
    switch (event.type) {
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') this.delta(chunk.text)
        return
      }
      case 'tool/call': {
        const summary = summarizeArgs(event.data.arguments)
        this.pending.set(event.data.callId, event.data.name)
        this.line(`${this.p.cyan('●')} ${this.p.bold(event.data.name)}${summary === '' ? '' : ` ${this.p.dim(summary)}`}`)
        return
      }
      case 'tool/result': {
        // The result's call correlation lives on its single tool-result block.
        const block = event.data.message.content[0]
        const called = this.pending.get(block.toolCallId) ?? 'tool'
        this.pending.delete(block.toolCallId)
        if (event.data.error !== undefined) {
          this.line(`  ${this.p.red('✗')} ${called}: ${this.p.red(event.data.error.code)}`)
          return
        }
        const text = block.content
          .map(inner => (inner.type === 'text' ? inner.text : `[${inner.type}]`))
          .join('')
        this.line(`  ${this.p.green('✓')} ${this.p.dim(preview(text))}`)
        return
      }
      case 'turn/end': {
        this.breakLine()
        const reason = event.data.reason
        if (reason.kind === 'error') {
          this.line(`${this.p.red('error')} ${reason.error.code}: ${reason.error.message}`)
        } else if (reason.kind !== 'completed') {
          this.line(this.p.yellow(`turn ended: ${reason.kind}`))
        }
        return
      }
      default:
        // Every other event is log-only for this surface.
        return
    }
  }
}

/**
 * Answer one approval question at the keyboard.
 * @param rl - the shared readline interface, briefly repurposed for the question.
 * @param io - process streams.
 * @param p - palette.
 * @param req - the pending decision.
 * @returns the user's outcome, or `'cancelled'` when the question is withdrawn.
 */
async function askApproval(rl: ReadlineInterface, io: TuiIo, p: Palette, req: ApprovalRequest): Promise<ApprovalOutcome> {
  const signal = req.signal
  if (signal?.aborted === true) return 'cancelled'
  io.stdout.write(`\n${p.yellow('?')} ${p.bold(req.toolName)} needs approval`)
  io.stdout.write(req.reason === undefined ? '\n' : ` ${p.dim(`— ${req.reason}`)}\n`)
  const answer = await new Promise<string>((resolve) => {
    // A withdrawn question must not leave the prompt hanging.
    const onAbort = (): void => { resolve('') }
    signal?.addEventListener('abort', onAbort, { once: true })
    rl.question(`  ${p.dim('[y] allow once  [n] reject > ')}`, (value) => {
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    })
  })
  // Re-read through the captured signal: the question may have been withdrawn
  // while the prompt was open.
  if (signal !== undefined && signal.aborted) return 'cancelled'
  return answer.trim().toLowerCase().startsWith('y') ? 'allowed-once' : 'rejected'
}

/** Result of handling one line of input: keep looping, or stop. */
type LineOutcome = 'continue' | 'exit'

/**
 * Interpret one input line. Slash commands are handled here and never reach
 * the model; anything else is submitted as a user message.
 * @param input - the raw line, already trimmed.
 * @param agent - the live agent.
 * @param io - process streams.
 * @param p - palette.
 * @returns whether the loop should continue.
 */
function handleLine(input: string, agent: Agent, io: TuiIo, p: Palette): LineOutcome {
  if (input === '') return 'continue'
  if (input === '/exit' || input === '/quit') return 'exit'
  if (input === '/clear') {
    io.stdout.write(clearScreen())
    return 'continue'
  }
  if (input === '/id') {
    io.stdout.write(`${p.dim(agent.session.header.id)}\n`)
    return 'continue'
  }
  if (input.startsWith('/')) {
    io.stdout.write(`${p.yellow('unknown command')} ${input} ${p.dim('— try /exit, /clear, /id')}\n`)
    return 'continue'
  }
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: input }],
    source: { kind: 'user' },
  }))
  return 'continue'
}

/**
 * Drive the interactive loop until the user leaves or the process is asked to exit.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param config - validated startup config.
 * @param io - process-facing effects.
 */
async function run(ctx: Context, config: Config, io: TuiIo): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const color = process.stdout.isTTY === true && process.env.NO_COLOR === undefined
  const p = palette(color)
  const selection = defaultModel.currentSelection()

  const { agent } = await agents.create({
    sessionId: SessionId(config.resume ?? `session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    },
  })

  const transcript = new Transcript(io, p)
  // Mirror only this agent's session; a subagent's child session has its own.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (session.header.id !== agent.session.header.id) return
    transcript.render(event)
  })

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  ctx.on('approval/request', async (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
    if (req.agent !== agent) return next()
    return askApproval(rl, io, p, req)
  })

  io.stdout.write(`${p.dim(`dsh · ${selection.model} · ${process.cwd()}`)}\n`)
  io.stdout.write(`${p.dim('/exit to leave, /id for the session id, Ctrl-C to cancel a turn')}\n\n`)

  // Ctrl-C cancels the turn in flight; at an idle empty prompt it exits.
  let idle = true
  rl.on('SIGINT', () => {
    if (idle) {
      rl.close()
      return
    }
    agent.cancel({ kind: 'user' })
    io.stdout.write(`\n${p.yellow('cancelled')}\n`)
  })

  let leaving = false
  rl.on('close', () => { leaving = true })

  await agent.whenIdle()
  while (!leaving) {
    const input = await new Promise<string | undefined>((resolve) => {
      // `close` (Ctrl-D) settles the pending question with no answer.
      rl.once('close', () => { resolve(undefined) })
      rl.question(`${p.cyan('›')} `, resolve)
    })
    if (input === undefined) break
    idle = false
    const outcome = handleLine(input.trim(), agent, io, p)
    if (outcome === 'exit') break
    await agent.whenIdle()
    idle = true
  }

  rl.close()
  await sessions.flush(agent.session)
  io.stdout.write(`\n${p.dim(`session ${agent.session.header.id}`)}\n`)
  io.exit(0)
}

/** Report an unexpected driver failure and request a failing exit. */
function fail(io: TuiIo, error: unknown): void {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/**
 * Mount the interactive terminal driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated startup config.
 */
export function apply(ctx: Context, config: Config): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: TuiIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch((error: unknown) => { fail(io, error) })
}
