/**
 * End-to-end tool choice: a `toolChoice` declared on a subagent tool row
 * reaches the outgoing request body of that agent's delegated turn.
 *
 * The model endpoint is the only scripted boundary. The tool, the in-process
 * subagent provider, the agent loop, the LLM seam, and the pi-ai adapter are
 * all shipping code, and the assertion is on the request body the mock
 * endpoint captured rather than on any intermediate object.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { PiAiAdapter } from '../../../llm/llm-pi-ai/src/index.ts'
import { resolveProfiles } from '../../../llm/llm-pi-ai/src/config.ts'
import type { PiAiProviderProfile } from '../../../llm/llm-pi-ai/src/config.ts'
import { memoryAuth } from '../../../llm/llm-pi-ai/tests/auth-double.ts'
import { closeMockServers, mockServer, textEvents } from '../../../llm/llm-pi-ai/tests/mock-server.ts'
import * as tool from '../src/index.ts'

const LOCAL_MODEL = 'local-compelled'

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

/** A hand-declared OpenAI-compatible route serving one model. */
function localProfile(baseURL: string): Record<string, PiAiProviderProfile> {
  return {
    local: {
      apiKeyEnv: 'PI_TEST_KEY',
      api: 'openai-completions',
      baseURL,
      models: [{ id: LOCAL_MODEL, name: 'Local model', contextWindow: 8192, maxTokens: 2048, input: ['text'] }],
    },
  }
}

/** The real delegation stack over one scripted model endpoint, with `row` as the tool row. */
async function wire(row: { provider: string; model: string; toolChoice?: 'required' } | undefined) {
  vi.stubEnv('PI_TEST_KEY', 'test-key')
  const server = await mockServer([{ events: textEvents }])
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(tool, { provider: 'spawn', ...row === undefined ? {} : { agentOptions: row } })
  ctx.llm.registerAdapter(['local'], new PiAiAdapter({
    profiles: () => resolveProfiles(localProfile(server.url)),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
  }))
  const parent = ctx.agentLoop.create(SessionId('wire-parent'), { provider: 'local', model: LOCAL_MODEL })
  return { ctx, server, parent }
}

/** Invoke the registered `subagent` tool exactly as the model would. */
function delegate(ctx: Context, parent: Agent, description: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`call-${description}`),
    name: 'subagent',
    arguments: { description, prompt: 'Reply OK' },
    agent: parent,
  })
}

describe('subagent tool row tool choice', () => {
  it('reaches the delegated turn request body', async () => {
    const { ctx, server, parent } = await wire({
      provider: 'local',
      model: LOCAL_MODEL,
      toolChoice: 'required',
    })

    await delegate(ctx, parent, 'compelled delegation')

    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({
      model: LOCAL_MODEL,
      tool_choice: 'required',
    })
  })

  it('sends no tool choice when the row declares none', async () => {
    const { ctx, server, parent } = await wire({ provider: 'local', model: LOCAL_MODEL })

    await delegate(ctx, parent, 'plain delegation')

    expect(server.requests).toHaveLength(1)
    const body = server.requests[0] as { tools?: unknown[]; tool_choice?: unknown }
    // The child offers tools, so the absent field is a decision rather than a
    // request that had nothing to choose between.
    expect(body.tools?.length).toBeGreaterThan(0)
    expect(body.tool_choice).toBeUndefined()
  })
})
