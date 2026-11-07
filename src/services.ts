import { Provider } from './provider.ts';
import { execute } from './executor.ts';
import { recordUsage } from './usage.ts';
import type { RuntimeServices, ServiceDependencies } from './contracts.ts';

/** Replaceable implementation; credentials, conversations and run ownership stay in the host. */
export function createServices(dependencies: ServiceDependencies): RuntimeServices {
  const provider = new Provider(dependencies.auth, dependencies.fetcher, dependencies.endpoint);
  return {
    models: signal => provider.models(signal),
    async complete(request) {
      const result = await provider.complete(request.model, request.input, request.instructions, request.signal, request.onDelta,
        { cacheScope: request.cacheScope });
      recordUsage(request.conversation, result.usage, request.model,
        request.instructions.startsWith('You are compacting historical conversation data') ? 'compaction' : 'conversation');
      request.save();
      return result;
    },
    execute: (code, tools, context) => execute(code, tools, context, 60_000, dependencies.workerURL),
  };
}
