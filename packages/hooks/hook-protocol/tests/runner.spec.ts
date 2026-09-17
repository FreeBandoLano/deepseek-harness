import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ShellExecRequest, ShellExecSpec, ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { DEFAULT_HOOK_TIMEOUT_MS, runHook } from '@deepseek-ai/dsh-hook-protocol'
import type { RunHookOptions } from '@deepseek-ai/dsh-hook-protocol'

/**
 * A minimal stand-in for the bits of {@link ShellExecutor} that {@link runHook}
 * actually calls (`resolve` then `run`). `runHook` is pure plumbing over those
 * two methods, so a duck-typed recorder is the right test hook — the REAL
 * executor (dsh-bash-local) is exercised end-to-end by the hook-bridge plugins
 * that consume this library, not here.
 */
function recordingBash(run: (spec: ShellExecSpec) => Promise<ShellRunResult>): {
  bash: ShellExecutor
  specs: ShellExecSpec[]
} {
  const specs: ShellExecSpec[] = []
  const bash = {
    resolve(request: ShellExecRequest): ShellExecSpec {
      // Carry the request through verbatim, defaulting the required spec fields —
      // exactly what dsh-bash-local's resolve does for the fields runHook sets.
      return {
        command: request.command,
        workdir: request.workdir ?? '/stub',
        timeoutMs: request.timeoutMs ?? 0,
        stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
        ...request.signal ? { signal: request.signal } : {},
        ...request.stdin !== undefined ? { stdin: request.stdin } : {},
        ...request.env !== undefined ? { env: request.env } : {},
        sandboxPolicy: request.sandboxPolicy,
      }
    },
    async run(spec: ShellExecSpec): Promise<ShellRunResult> {
      specs.push(spec)
      return run(spec)
    },
  } as unknown as ShellExecutor
  return { bash, specs }
}

function result(over: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 1000,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    ...over,
  }
}

const clock = () => { let t = 0; return () => (t += 5) } // +5ms per call → duration 5
const testSignal = (): AbortSignal => new AbortController().signal

describe('runHook — payload + env + stdin plumbing', () => {
  it('requires an explicit caller-owned abort signal', () => {
    expectTypeOf<RunHookOptions['signal']>().toEqualTypeOf<AbortSignal>()
  })

  it('serializes the payload to stdin (with trailing newline when requested)', async () => {
    const { bash, specs } = recordingBash(async () => result({ stdout: { text: '', truncated: false } }))
    await runHook(bash, { command: 'my-hook.sh' }, {
      payload: { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
      signal: testSignal(),
      defaultTimeoutMs: 60000,
      trailingNewline: true,
    }, clock())
    expect(specs[0]!.stdin).toBe(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }) + '\n')
    expect(specs[0]!.command).toBe('my-hook.sh')
  })

  it('omits the trailing newline when trailingNewline is false (Codex)', async () => {
    const { bash, specs } = recordingBash(async () => result())
    await runHook(bash, { command: 'h' }, { payload: { a: 1 }, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: false }, clock())
    expect(specs[0]!.stdin).toBe('{"a":1}')
  })

  it('threads env and cwd into the request', async () => {
    const { bash, specs } = recordingBash(async () => result())
    await runHook(bash, { command: 'h' }, {
      payload: {}, env: { CLAUDE_PROJECT_DIR: '/proj' }, cwd: '/work', signal: testSignal(),
      defaultTimeoutMs: 1000, trailingNewline: true,
    }, clock())
    expect(specs[0]!.env).toEqual({ CLAUDE_PROJECT_DIR: '/proj' })
    expect(specs[0]!.workdir).toBe('/work')
  })

  it('a per-hook timeoutSec (seconds) overrides the default (ms)', async () => {
    const { bash, specs } = recordingBash(async () => result())
    await runHook(bash, { command: 'h', timeoutSec: 3 }, { payload: {}, signal: testSignal(), defaultTimeoutMs: 60000, trailingNewline: true }, clock())
    expect(specs[0]!.timeoutMs).toBe(3000)
  })

  it('falls back to the default timeout when the hook sets none', async () => {
    const { bash, specs } = recordingBash(async () => result())
    await runHook(bash, { command: 'h' }, { payload: {}, signal: testSignal(), defaultTimeoutMs: 60000, trailingNewline: true }, clock())
    expect(specs[0]!.timeoutMs).toBe(60000)
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(600_000) // the CC/Codex reference default (10 minutes)
  })

  it('passes the abort signal through', async () => {
    const controller = new AbortController()
    const { bash, specs } = recordingBash(async () => result())
    await runHook(bash, { command: 'h' }, { payload: {}, signal: controller.signal, defaultTimeoutMs: 1000, trailingNewline: true }, clock())
    expect(specs[0]!.signal).toBe(controller.signal)
  })
})

describe('runHook — outcome decoding + duration', () => {
  it('decodes a clean exit with structured stdout and reports a duration', async () => {
    const { bash } = recordingBash(async () => result({
      exitCode: 0, stdout: { text: JSON.stringify({ decision: 'block', reason: 'no' }), truncated: false },
    }))
    const { output, durationMs } = await runHook(bash, { command: 'h' }, { payload: {}, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: true }, clock())
    expect(output.decision).toBe('block')
    expect(output.reason).toBe('no')
    expect(durationMs).toBe(5)
  })

  it('a signal death (exitCode null) decodes as undefined exit (non-blocking error)', async () => {
    const { bash } = recordingBash(async () => result({ exitCode: null, signal: 'SIGKILL', stderr: { text: 'killed', truncated: false } }))
    const { output } = await runHook(bash, { command: 'h' }, { payload: {}, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: true }, clock())
    expect(output.exitCode).toBeUndefined()
    expect(output.decision).toBeUndefined()
    expect(output.stderr).toBe('killed')
  })

  it('an executor rejection (infra fault) becomes a non-blocking error, never throws', async () => {
    const { bash } = recordingBash(async () => { throw new Error('bad workdir: ENOENT') })
    const { output } = await runHook(bash, { command: 'h' }, { payload: {}, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: true }, clock())
    expect(output.exitCode).toBeUndefined()
    expect(output.stderr).toBe('bad workdir: ENOENT')
    expect(output.decision).toBeUndefined()
  })

  it('a non-Error rejection is stringified onto stderr', async () => {
    const { bash } = recordingBash(async () => { throw 'plain string fault' })
    const { output } = await runHook(bash, { command: 'h' }, { payload: {}, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: true }, clock())
    expect(output.stderr).toBe('plain string fault')
  })

  it('threads expectedEventName so a mismatched hookSpecificOutput block is discarded', async () => {
    const { bash } = recordingBash(async () => result({
      exitCode: 0,
      stdout: { text: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } }), truncated: false },
    }))
    const { output } = await runHook(bash, { command: 'h' }, {
      payload: {}, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: true, expectedEventName: 'Stop',
    }, clock())
    // A PreToolUse block on a Stop hook is malformed → its decision is discarded.
    expect(output.hookEventName).toBe('PreToolUse')
    expect(output.decision).toBeUndefined()
  })
})

describe('runHook — a cut-off capture is carried out as a fault', () => {
  it('a truncated stdout is unusable and names the cap the executor applied', async () => {
    const { bash } = recordingBash(async () => result({
      exitCode: 0,
      // Valid JSON in the surviving prefix: the case that used to be silent.
      stdout: { text: '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"cut', truncated: true },
    }))
    const { output } = await runHook(bash, { command: 'h' }, {
      payload: {}, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: true, expectedEventName: 'SessionStart',
    }, clock())
    expect(output.unusable?.kind).toBe('stdout-truncated')
    expect(output.unusable?.detail).toContain('64000-byte cap')
    expect(output.additionalContext).toBeUndefined()
  })

  it('a truncated stderr is unusable too (the reason would be a prefix)', async () => {
    const { bash } = recordingBash(async () => result({
      exitCode: 2, stderr: { text: 'blocked: the cata', truncated: true },
    }))
    const { output } = await runHook(bash, { command: 'h' }, { payload: {}, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: true }, clock())
    expect(output.decision).toBe('block')
    expect(output.unusable?.kind).toBe('stderr-truncated')
  })

  it('a hook the executor could not start is unusable AND names the workdir it was given', async () => {
    // The real fault this models: a session whose workspace directory is gone.
    // The spawn error names the PROGRAM (`spawn bwrap ENOENT`) while the missing
    // thing is the directory, so the workdir has to ride along or the record
    // sends the reader hunting for a binary that is present.
    const { bash } = recordingBash(async () => { throw new Error('spawn bwrap ENOENT') })
    const { output } = await runHook(bash, { command: 'h' }, {
      payload: {}, signal: testSignal(), defaultTimeoutMs: 1000, trailingNewline: true, cwd: '/deleted/workspace',
    }, clock())
    expect(output.unusable?.kind).toBe('not-run')
    expect(output.unusable?.detail).toContain('spawn bwrap ENOENT')
    expect(output.unusable?.detail).toContain('/deleted/workspace')
    // The fail-open contract is unchanged: the turn proceeds, nothing throws.
    expect(output.exitCode).toBeUndefined()
  })
})
