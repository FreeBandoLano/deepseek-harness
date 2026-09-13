# Agent Note: A compelled turn fails loudly instead of answering in prose

Status: implemented

English | [中文](2026-09-13-tool-choice-enforcement.zh.md)

## Problem

Carrying a tool choice to the request body makes the requirement visible to the provider; it does not make it hold. A gateway may ignore the field and a model may answer in prose anyway, and before this change such a response was an ordinary success: the caller asked for a call, received text, and had no way to tell that the requirement had been dropped. That is the failure mode the whole feature exists to remove, one layer further out.

Two neighbouring facts must not collapse into it. A response the output cap cut off never reached the call, and reporting it as an ignored requirement would make a compellable reasoning model look un-compellable — a misreading that has already happened once while probing routes. A completion that produced nothing at all is already a typed empty-response failure, and it is a different degenerate case.

## Decision

The pi-ai stream converter classifies a terminal `stop` that carries content but no tool call, while the request declared a tool choice, as `finish { kind: 'error' }` with the new canonical code `TOOL_CHOICE_UNMET` (`packages/llm/llm/src/error.ts`). The failure message names what was owed — the required function by name when the choice named one, the requirement itself otherwise.

The classification lives in `mapStopReason` (`packages/llm/llm-pi-ai/src/stream.ts`), beside the empty-response mapping it extends, and takes the request's declared choice as a third argument threaded through `toStreamChunks`. Two orderings in that function are part of the decision: the check reads the `stop` reason only, so `length` still reports `max-tokens`; and it runs after the empty-content check, so a degenerate completion still reports `EMPTY_RESPONSE`.

The code is deliberately absent from `DEFAULT_RETRYABLE_CODES` (`packages/llm/llm/src/retry-policy.ts`). A transient retry policy repeats a request whose attempt produced nothing durable; this attempt produced an answer that refuses the requirement, so a retry asks the same model the same question and should expect the same refusal.

The failure reaches the delegating agent verbatim because the in-process one-shot driver now authors `SubagentResult.diagnostic` from the child's terminal `turn/end` failure — code and message — bounded by the seam's existing 4 KiB limiter, which is exported for that reuse. Before this, every failed in-process child reported only `subagent run failed` plus its partial output, so the orchestrator could see that something failed but not which requirement was ignored.

## Alternatives considered

**Converting a prose answer into a successful message with a warning.** Rejected: it is the silent downgrade in a different costume. The caller cannot distinguish a compelled answer from an uncompelled one if both arrive as ordinary messages, and the warning would live in a place no orchestrator reads.

**Retrying the same request.** Rejected on the reasoning above: a content failure is not a transient one, and a retry loop on a model that ignores the requirement converts one wasted call into several.

**Folding the case into the existing `EMPTY_RESPONSE` failure.** Rejected: an empty completion and a prose answer are different facts with different fixes — one is a provider hiccup worth retrying, the other is a model refusing the requirement. Collapsing them would also make the empty case unretryable and hide which of the two happened.

**Classifying at the adapter rather than in the converter.** Rejected: the converter already owns the terminal-stop vocabulary including the neighbouring empty-response case, and a second classification site would have to re-derive what counts as a tool call.

**Matching the named function against the calls the model made.** Not implemented: the requirement is that a call happens, which is what the tool-choice field asks a provider for. A response that calls a different tool than a named choice requested is accepted, and closing that would need its own decision about what a named choice means to a gateway that only reports "a tool was called".

## Consequences

An agent that declares a tool choice now fails its turn rather than accepting prose, and the delegating agent receives the typed failure — code and message — beside the child's partial output.

Every failed in-process child now carries a diagnostic, not only compelled ones. That is a widening of what the delegating agent sees: provider failure text that already reached out-of-process backends now reaches in-process callers too, under the same bound.

Two gaps remain, both tracked separately. Whether a route whose protocol structurally cannot carry the field should be refused before the request is a separate decision; until it lands, a `toolChoice` on such a route is silently uncompelled rather than loudly wrong. And the option's named-function form is enforced only as "a call happened".

## Testing

`packages/llm/llm-pi-ai/tests/adapter.spec.ts` drives the real runtime and the real SDK against the in-repo mock endpoint: a compelled prose completion fails with `TOOL_CHOICE_UNMET` naming the required function, the identical completion uncompelled stays a success, a completion the cap cut off stays `max-tokens`, a completion that produced nothing stays `EMPTY_RESPONSE`, and a completion that calls the tool stays `tool-calls`. `packages/subagent/tool-subagent/tests/tool-choice-wire.spec.ts` repeats the pair at the delegation seam and asserts the delegating agent receives the requirement in the failure text. `packages/llm/llm-retry/tests/retry.spec.ts` asserts the failure is not retried under the default policy.
