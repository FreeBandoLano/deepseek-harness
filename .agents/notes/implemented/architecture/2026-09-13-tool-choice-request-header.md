# Agent Note: A per-agent tool choice reaches the logged request header and the wire

Status: implemented

English | [中文](2026-09-13-tool-choice-request-header.zh.md)

## Problem

A deployment needs to say that one agent's conversation turn has to call a tool, and have that hold at the provider instead of in a persona clause a model can ignore. The motivating agent's rule is that nothing is claimed to work until the simulator ran it; prose cannot enforce that, and an OpenAI-compatible gateway accepts `tool_choice: "required"`.

The harness could not express the requirement anywhere. `AgentOptions` carried provider, model, and an output cap; neither `GenerateOptions` nor `LlmCallConfig` had a tool-choice field; and the pi-ai adapter forwards an explicit allow-list of options to the SDK, so a field it does not name never leaves the process. The dependency already carried the field and wrote it to the request body, so this was a plumbing gap rather than a missing capability.

## Decision

A tool choice is per-agent state. It is declared as `toolChoice` inside the same `agentOptions` block a subagent tool row already uses for provider, model, and output cap, and it speaks the protocol's own vocabulary — `'none'`, `'auto'`, `'required'`, or a named function — so a later function-specific requirement needs no second option.

The value travels as request-header state rather than a side channel:

1. `AgentOptions.toolChoice` (`packages/core/agent/src/runtime-types.ts`) is the agent-level declaration a subagent tool row hands its child loop.
2. The shipped `dsh-tool-subagent` config schema accepts it in that block, so a `cordis.yml` row declares it beside the rest of the agent's facts.
3. The agent loop seeds it into the first request header it logs (`packages/core/agent-loop/src/agent.ts`); every later request is assembled by spreading that logged header.
4. `LlmCallConfig.toolChoice` (`packages/llm/llm/src/call-config.ts`) makes it header state, so `callConfigEquals` — and therefore `headerEquals` — treats a change as a real change and the loop logs a changed header snapshot instead of substituting silently.
5. `GenerateOptions.toolChoice` (`packages/llm/llm/src/types.ts`) carries it into the assembled request.
6. The pi-ai adapter forwards it into `Models.streamSimple()` (`packages/llm/llm-pi-ai/src/adapter.ts`), whose simple stream entry maps the harness reasoning level onto the protocol's effort and writes the field into the request body.

A fresh loop instance over a seeded log prefers the declaration in hand, and otherwise restores the logged header's own value when the persisted route is the route it is starting under. A route the log disagrees with drops it, and that drop is a logged header change.

Auxiliary model calls are never compelled. Compaction and session titles derive only a provider and a model from the session header, so the requirement cannot reach them; the compaction and session-title suites pin that for each.

## Alternatives considered

**A boolean `mustCallTool` flag.** Rejected: it cannot express "do not call a tool", and naming one function would need a second field.

**Expressing the requirement per turn through the existing `agent/request` waterfall.** Rejected: it needs the same request field and adds a deployment plugin to express one fact, while leaving the declaration somewhere no agent row can carry it.

**A global "every agent must call a tool" policy.** Rejected: it would compel agents that legitimately answer in prose.

**Swapping the adapter to the protocol's full stream entry, which declares the tool choice.** Rejected: the simple entry is the one that maps the harness reasoning level onto the protocol's effort, and it owns the retry and replay boundary. The adapter instead names the field in the options that entry forwards, and the adapter spec pins the resulting body.

**Recording the requirement in the continuable subagent descriptor.** Rejected: the descriptor snapshots composition for cold resume, and a field it omits is recovered from the child's own logged header, which is already the durable record of what that child's requests were built under. Storing it in both places would give one fact two sources of truth, and bumping `SUBAGENT_DESCRIPTOR_VERSION` would strand every continuable child already on disk.

## Consequences

An agent row that declares `toolChoice` is compelled at the provider on every conversation request it builds, and the requirement survives resume because the log holds it rather than the caller.

Only the pi-ai (OpenAI-compatible) routes carry it. The DeepSeek adapter has its own request translation and ignores the field, so a route that structurally cannot carry a declared choice is not yet refused; a change that refuses it at the earliest knowable point is tracked separately. Until that lands, a `toolChoice` on a route with no such field is silently uncompelled. A gateway that accepts the field and ignores it is undetectable from here for the same reason: the requirement is a request, and the response half — failing a turn that answers in prose while a requirement was in force — is also tracked separately.

Because the value is restored from the logged header, removing `toolChoice` from a row cannot un-compel a session already in flight; the requirement changes through the `agent/request` waterfall and the change is logged. That asymmetry is deliberate: the failure this design guards against is a resume that quietly weakens enforcement, not one that keeps it.

No persona text changed, and no agent's routed model changed.

## Testing

`packages/llm/llm-pi-ai/tests/adapter.spec.ts` asserts the captured request body carries `tool_choice: "required"` beside the mapped `reasoning_effort`, and that the same request with no declaration carries no `tool_choice` while still naming its tools. `packages/subagent/tool-subagent/tests/tool-choice-wire.spec.ts` drives a real subagent tool row through the in-process delegation stack to the same mock endpoint and asserts the delegated turn's body, with the undeclared row as its control. `packages/core/agent-loop/tests/request-reconstruction.spec.ts` pins the logged header, the changed-header path, and the resume rebuild; `packages/core/agent-loop/tests/invariant.spec.ts` pins the request-versus-folded-header check that makes an unlogged requirement impossible.
