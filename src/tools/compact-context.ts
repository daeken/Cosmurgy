import { COMPACT_REQUEST } from '../context.ts';
export default {
  name: 'compactContext',
  description: 'Request oldest-context summarization at the next safe model boundary. Preserve the latest 6 user turns and the visible transcript. Call with: return await tools.compactContext(); as the entire execute result (do not bury it in another object). This queues compaction; the next runtime step reports its outcome.',
  signature: '() => { request: string; queued: boolean }',
  run() { return { request: COMPACT_REQUEST, queued: true }; },
};
