/**
 * The runtime half of tool-choice capability.
 *
 * Two rules, and they point in opposite directions on purpose:
 *
 *   - an adapter that DECLARES its protocol carries no field for the declared
 *     choice is refused, typed, before any request exists;
 *   - an adapter that declares NOTHING is warned about, naming the adapter, the
 *     route and the declared value, and the call proceeds. Absent capability
 *     data is not evidence of absence — the seam already says so for the
 *     advisory catalog, whose absence "must not be turned into request
 *     rejection" — so proceeding is the correct default and the warning is what
 *     keeps it from being silent.
 *
 * The warning's three names are asserted rather than its wording: a warning
 * that cannot say who could not be asked is not actionable.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, TOOL_CHOICE_UNSUPPORTED_CODE } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  StreamChunk,
  ToolChoice,
  ToolChoiceSupport,
} from '@deepseek-ai/dsh-llm'

const ROUTE = 'a-route'
const MODEL = 'a-model'

abstract class DeadAdapter extends LlmAdapter {
  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('this spec never dispatches')
  }
}

/** An adapter written before the capability field existed: it says nothing. */
class SilentAdapter extends DeadAdapter {}

/** An adapter that answers the question. */
class DeclaringAdapter extends DeadAdapter {
  constructor(private readonly support: ToolChoiceSupport) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, toolChoice: this.support })
  }
}

async function setup(adapter: LlmAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([ROUTE], adapter)
  return ctx
}

const config = (toolChoice: ToolChoice) => ({ provider: ROUTE, model: MODEL, toolChoice })

describe('tool-choice capability at the runtime seam', () => {
  it('warns — naming adapter, route and value — and proceeds when nothing is declared', async () => {
    const ctx = await setup(new SilentAdapter())
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

    await expect(ctx.llm.prepareCall(config('required'))).resolves.toBeDefined()

    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0]?.[0] ?? '')
    expect(line).toContain('SilentAdapter')
    expect(line).toContain(ROUTE)
    expect(line).toContain('required')
  })

  it('says nothing at all when no tool choice is declared', async () => {
    const ctx = await setup(new SilentAdapter())
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)

    await expect(ctx.llm.prepareCall({ provider: ROUTE, model: MODEL })).resolves.toBeDefined()

    // The check is scoped to a request that asks for something: a route whose
    // protocol is limited stays fully usable for every caller that is not
    // compelled, and a warning per ordinary call would be noise that gets muted.
    expect(warn).not.toHaveBeenCalled()
  })

  it('refuses, naming the protocol, when the declaration says the kind is not carried', async () => {
    const ctx = await setup(new DeclaringAdapter({ protocol: 'a-limited-protocol', carries: ['none', 'auto'] }))

    await expect(ctx.llm.prepareCall(config('required'))).rejects.toMatchObject({
      code: TOOL_CHOICE_UNSUPPORTED_CODE,
      message: expect.stringContaining('a-limited-protocol'),
    })
    await expect(ctx.llm.prepareCall(config('auto'))).resolves.toBeDefined()
  })

  it('refuses an adapter that declares a malformed capability', async () => {
    const ctx = await setup(new DeclaringAdapter(
      { protocol: '', carries: ['required'] } as unknown as ToolChoiceSupport,
    ))

    // A declaration nothing can read is worse than none: it would look like a
    // capability answer while carrying no protocol to name in the refusal.
    await expect(ctx.llm.prepareCall(config('required'))).rejects.toMatchObject({
      code: 'INVALID_MODEL_TOOL_CHOICE',
    })
  })
})
