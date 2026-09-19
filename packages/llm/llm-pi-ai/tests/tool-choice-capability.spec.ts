/**
 * Tool-choice capability: a requirement declared for a route whose protocol
 * cannot carry it fails LOUDLY, and no request is sent.
 *
 * STRUCTURAL, NOT BEHAVIOURAL. This asks what the protocol's implementation
 * forwards, never what an endpoint happens to honour — the latter is a measured
 * fact with its own probe evidence, and a declaration about it would be a
 * second, drifting copy of it in the wrong place.
 *
 * ONLY ONE PROTOCOL CARRIES A CHOICE THROUGH THE ENTRY DSH CALLS. Every protocol's
 * `streamSimple` builds its stream options from `buildBaseOptions`, which does
 * not copy `toolChoice` (`dist/api/simple-options.js:10-28`); `openai-completions`
 * re-adds the field explicitly and the other two do not, so `openai-responses`
 * and `anthropic-messages` never hand it to their request builders at all. That
 * is why both declare `carries: []` in the table below, and why a choice on
 * either route is refused rather than dropped in silence.
 *
 * The vocabulary differences those unreachable builders DO have are real and
 * untranslated — `anthropic-messages.js:789-796` wraps a string as
 * `{type:<value>}` and passes an object through, so our `'required'` would
 * become the malformed `{type:"required"}` its own vocabulary never names, and
 * its named form is `{type:'tool', name}` where the Responses one is flat — but
 * they sit DOWNSTREAM of the arrival gap and cannot be measured here until a
 * delivery path the simple entry forwards exists. See
 * `~/.dsh/reports/upstream-simple-entry-tool-choice.md`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, TOOL_CHOICE_UNSUPPORTED_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

const MODEL = 'local-capability'

type Protocol = NonNullable<PiAiProviderProfile['api']>

/** One hand-declared route speaking exactly one protocol, serving one model. */
function profile(baseURL: string, api: Protocol): Record<string, PiAiProviderProfile> {
  return {
    deepseek: {
      apiKeyEnv: 'PI_TEST_KEY',
      api,
      baseURL,
      models: [{ id: MODEL, name: 'Local model', contextWindow: 8192, maxTokens: 2048, input: ['text'] }],
    },
  }
}

/** The real runtime and the real adapter over one scripted endpoint. */
async function harness(baseURL: string, api: Protocol): Promise<Context> {
  vi.stubEnv('PI_TEST_KEY', 'test-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['deepseek'], new PiAiAdapter({
    profiles: () => resolveProfiles(profile(baseURL, api)),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
  }))
  return ctx
}

const ask = {
  model: MODEL,
  messages: [createUserMessage({
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'plugin' as const, plugin: 'tool-choice-capability' },
  })],
}

/** The typed failure one assembled call ended in, or `undefined` if it did not fail. */
function failureOf(finish: { kind: string; failure?: LlmFailure }): LlmFailure | undefined {
  return finish.kind === 'error' ? finish.failure : undefined
}

describe('tool-choice capability', () => {
  it('refuses a requirement the protocol cannot carry, and sends nothing', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, 'anthropic-messages')

    const result = await assemble(ctx, { ...ask, toolChoice: 'required' })

    // Typed, and the protocol is NAMED: a failure that says only "tool choice
    // unsupported" leaves the operator guessing which route limitation to fix.
    expect(failureOf(result.finish)?.code).toBe(TOOL_CHOICE_UNSUPPORTED_CODE)
    expect(failureOf(result.finish)?.message).toContain('anthropic-messages')
    // The whole point: the declaration is not quietly dropped, so nothing went out.
    expect(server.requests).toHaveLength(0)
  })

  it('refuses before any request header is logged, on the path the loop takes', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, 'anthropic-messages')

    // `prepareCall` is what the agent loop calls to assemble a turn's request;
    // throwing here is what keeps the session log from showing a compelled
    // header for a request that was never sent.
    await expect(ctx.llm.prepareCall({ provider: 'deepseek', model: MODEL, toolChoice: 'required' }))
      .rejects.toMatchObject({ code: TOOL_CHOICE_UNSUPPORTED_CODE })
    expect(server.requests).toHaveLength(0)
  })

  it('carries the same requirement on a protocol that has the field', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, 'openai-completions')

    const result = await assemble(ctx, { ...ask, toolChoice: 'required' })

    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({ tool_choice: 'required' })
    // The scripted answer is prose, so a requirement that ARRIVED fails the turn
    // (#12) — which is the strongest available proof that the field reached the
    // wire: the response half only fires when the request half was in force.
    expect(failureOf(result.finish)?.code).toBe('TOOL_CHOICE_UNMET')
  })

  it('refuses every kind on a protocol the simple entry does not feed', async () => {
    // The refusal is per PROTOCOL here, not only per value: on `anthropic-messages`
    // the field never arrives at all, so the two kinds this route was believed to
    // share with our vocabulary are refused exactly like the two it never had.
    // Before the arrival gap was measured this case asserted the opposite — that
    // `auto` and `none` RESOLVED here — which is the drift the table now forbids:
    // a capability claimed for a mechanism that does not deliver it.
    const ctx = await harness('http://127.0.0.1:1', 'anthropic-messages')

    for (const toolChoice of ['none', 'auto', 'required'] as const) {
      await expect(ctx.llm.prepareCall({ provider: 'deepseek', model: MODEL, toolChoice }))
        .rejects.toMatchObject({ code: TOOL_CHOICE_UNSUPPORTED_CODE })
    }
    await expect(ctx.llm.prepareCall({
      provider: 'deepseek',
      model: MODEL,
      toolChoice: { type: 'function', function: { name: 'run_ghdl' } },
    })).rejects.toMatchObject({ code: TOOL_CHOICE_UNSUPPORTED_CODE })
  })

  it('declares, per protocol, exactly what that implementation forwards', async () => {
    // Pinned per protocol because the table decides whether a turn runs at all: a
    // silent edit to a `carries` list changes behaviour with no other signal. The
    // two empty rows are the measured truth rather than caution — the simple entry
    // dsh calls forwards `toolChoice` for `openai-completions` only, so a choice
    // declared on either other route never reaches its request builder. They are
    // refused instead of dropped silently, and they carry again only when a
    // delivery path the simple entry forwards (or the upstream fix) lands.
    const expected = {
      'openai-completions': ['none', 'auto', 'required', 'function'],
      'openai-responses': [],
      'anthropic-messages': [],
    }
    for (const [api, carries] of Object.entries(expected)) {
      const ctx = await harness('http://127.0.0.1:1', api)
      expect((await ctx.llm.resolveModelInfo('deepseek', MODEL)).toolChoice)
        .toEqual({ protocol: api, carries })
    }
  })

  it('leaves a route with no declaration at all completely alone', async () => {
    const server = await mockServer([{ events: textEvents }])
    const ctx = await harness(server.url, 'anthropic-messages')

    // Nothing declared, nothing checked: the refusal is scoped to a request that
    // actually asks for something the protocol cannot express. The call is made
    // (the mock is a chat-completions responder, so its own reply does not
    // matter here) and carries no tool choice.
    await assemble(ctx, ask)
    expect(server.requests).toHaveLength(1)
    expect((server.requests[0] as { tool_choice?: unknown }).tool_choice).toBeUndefined()
  })
})
