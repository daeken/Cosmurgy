import type { Conversation, ConversationUsage, TokenUsage } from './contracts.ts';
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** Copy only validated counters, never response metadata or server text. */
export function parseUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as Record<string, any>;
  if (!count(value.input_tokens) || !count(value.output_tokens) || !count(value.total_tokens)) return;
  const usage: TokenUsage = { inputTokens: value.input_tokens, outputTokens: value.output_tokens, totalTokens: value.total_tokens };
  const cached = value.input_tokens_details?.cached_tokens;
  if (count(cached) && cached <= usage.inputTokens) usage.cachedInputTokens = cached;
  return usage;
}
export function recordUsage(conversation: Conversation, tokens: TokenUsage | undefined, model: string,
  purpose: ConversationUsage['last']['purpose']): void {
  const previous = conversation.usage;
  conversation.usage = {
    completedRequests: (previous?.completedRequests ?? 0) + 1,
    reportedRequests: (previous?.reportedRequests ?? 0) + (tokens ? 1 : 0),
    cacheReportedRequests: (previous?.cacheReportedRequests ?? 0) + (tokens?.cachedInputTokens !== undefined ? 1 : 0),
    inputTokens: (previous?.inputTokens ?? 0) + (tokens?.inputTokens ?? 0),
    outputTokens: (previous?.outputTokens ?? 0) + (tokens?.outputTokens ?? 0),
    totalTokens: (previous?.totalTokens ?? 0) + (tokens?.totalTokens ?? 0),
    cachedInputTokens: (previous?.cachedInputTokens ?? 0) + (tokens?.cachedInputTokens ?? 0),
    last: { at: new Date().toISOString(), model, purpose, ...(tokens ? { tokens } : {}) },
  };
}
/** Compact status for the last completed request; absence is explicitly unknown. */
export function cacheStatus(conversation: Conversation): string {
  const last = conversation.usage?.last;
  if (!last) return 'Cache: awaiting usage';
  const usage = last.tokens;
  const label = last.purpose === 'compaction' ? 'Summary cache' : 'Cache';
  if (!usage) return label + ': usage not reported';
  if (usage.cachedInputTokens === undefined) return label + ': not reported · ' + usage.inputTokens.toLocaleString() + ' input';
  const percent = usage.inputTokens ? Math.round(usage.cachedInputTokens / usage.inputTokens * 100) : 0;
  return label + ': ' + percent + '% · ' + usage.cachedInputTokens.toLocaleString() + '/' + usage.inputTokens.toLocaleString() + ' input';
}
export function usageDetails(conversation: Conversation): string {
  const usage = conversation.usage;
  if (!usage) return 'Usage will appear after a completed request reports token counts.';
  return 'Completed requests: ' + usage.completedRequests + ' · usage reported: ' + usage.reportedRequests + ' · cache reported: ' + usage.cacheReportedRequests
    + '\nReported totals (including summaries): ' + usage.inputTokens.toLocaleString() + ' input · ' + usage.cachedInputTokens.toLocaleString() + ' cached input · ' + usage.outputTokens.toLocaleString() + ' output.';
}
