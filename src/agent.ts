import { COMPACT_REQUEST, compact, compactablePrefix, contextPolicy, contextTooLarge, estimateTokens, expireToolResults, modelInput } from './context.ts';
import type { AgentContext, Completion } from './contracts.ts';

/** Reloaded between runs. Its durable inputs and messages belong to the host. */
export async function run(context: AgentContext): Promise<void> {
  const { conversation, signal } = context;
  // A crash may have left completed model calls without their results. Never replay side effects.
  const answered = new Set(conversation.input.filter(item => item.type === 'function_call_output').map(item => item.call_id));
  for (const item of [...conversation.input]) {
    if (item.type === 'function_call' && !answered.has(item.call_id)) {
      conversation.input.push({ type: 'function_call_output', call_id: item.call_id,
        output: JSON.stringify({ error: 'Execution was interrupted. Inspect current state before attempting this work again.' }) });
    }
  }
  context.save();
  let compactionBlocked = false;
  const tryCompact = async () => {
    try {
      const changed = await compact(context);
      if (!changed) {
        compactionBlocked = true;
        if (conversation.context?.requested) {
          conversation.context.requested = false;
          context.message('notice', 'No older turns to compact; the latest ' + contextPolicy.keepRecentTurns + ' user turns are protected.');
          context.save();
        }
      }
      return changed;
    } catch (error) {
      signal.throwIfAborted();
      compactionBlocked = true;
      context.message('notice', 'Context compaction failed; original context was kept. It can be retried on the next turn.');
      return false;
    }
  };
  for (let step = 0; step < 40; step++) {
    signal.throwIfAborted();
    if (expireToolResults(conversation)) context.save();
    const instructions = context.instructions();
    const estimated = estimateTokens([modelInput(conversation), instructions]) + 4_000;
    if (!compactionBlocked && (conversation.context?.requested || estimated >= contextPolicy.contextWindowTokens * contextPolicy.triggerRatio)) {
      await tryCompact();
    }
    let assistant: ReturnType<AgentContext['message']> | undefined;
    let streamed = '';
    const onDelta = (delta: string) => {
      streamed += delta;
      if (!assistant) assistant = context.message('assistant', streamed);
      else context.update(assistant, streamed);
    };
    let completion: Completion;
    try { completion = await context.complete(modelInput(conversation), instructions, onDelta); }
    catch (error) {
      signal.throwIfAborted();
      if (!contextTooLarge(error) || streamed) throw error;
      if (compactionBlocked || !compactablePrefix(conversation.input) || !await tryCompact()) {
        throw new Error('Context is full and could not be compacted without changing protected recent turns. Shorten the current request, request compaction again, or start a new conversation.');
      }
      // Retry only the rejected model request, never any tool execution.
      completion = await context.complete(modelInput(conversation), instructions, onDelta);
    }
    conversation.input.push(...completion.output);
    const text = completion.output.filter(item => item.type === 'message')
      .flatMap(item => Array.isArray(item.content) ? item.content : [])
      .filter(part => part.type === 'output_text' || part.type === 'refusal')
      .map(part => part.text ?? part.refusal ?? '').join('\n');
    if (text) {
      if (assistant) context.update(assistant, text); else context.message('assistant', text);
    }
    context.save();
    if (!completion.calls.length) {
      if (!text && !streamed) context.message('notice', 'The model completed without a text response.');
      return;
    }
    for (const call of completion.calls) {
      let code = ''; let output: unknown;
      try {
        signal.throwIfAborted();
        if (!['execute', 'cosmurgy.execute'].includes(call.name)) throw new Error(`Unknown tool: ${call.name}`);
        const args = JSON.parse(call.arguments);
        if (typeof args.code !== 'string') throw new Error('execute requires a TypeScript code string.');
        code = args.code;
        const activity = context.message('tool', 'Running TypeScript', code);
        try {
          output = await context.execute(code);
          context.update(activity, 'TypeScript completed');
          activity.detail = `${code}\n\n${JSON.stringify(output, null, 2)}`;
        } catch (error) {
          context.update(activity, signal.aborted ? 'TypeScript stopped' : 'TypeScript failed');
          throw error;
        }
      } catch (error) { output = { error: error instanceof Error ? error.message : String(error) }; }
      if ((output as { result?: { request?: string } } | undefined)?.result?.request === COMPACT_REQUEST) {
        conversation.context = { ...conversation.context, requested: true };
      }
      conversation.input.push({ type: 'function_call_output', call_id: call.id,
        output: JSON.stringify(output).slice(0, 30_000) });
      context.save();
    }
    signal.throwIfAborted();
  }
  context.message('notice', 'Paused after 40 model steps. Send a message to continue.');
}
