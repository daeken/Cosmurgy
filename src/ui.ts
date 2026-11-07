import * as Native from 'jonui';
export * from 'jonui';

export function Component<Props = void>(setup: (scope: Native.ComponentScope<Props>, initial: Props) => (props: Props) => Native.View): (props: Props) => Native.View {
  return Native.Component<Props>((scope, initial) => {
    const effect: Native.ComponentScope<Props>['effect'] = callback => scope.effect(() => {
      try {
        const cleanup = callback();
        return cleanup ? () => { try { cleanup(); } catch (error) { report(error); } } : undefined;
      } catch (error) { report(error); }
    });
    const task: Native.ComponentScope<Props>['task'] = callback => scope.task(async task => {
      try { await callback(task); } catch (error) { if (!task.signal.aborted) report(error); }
    });
    const onDispose: Native.ComponentScope<Props>['onDispose'] = callback => scope.onDispose(() => { try { callback(); } catch (error) { report(error); } });
    const guarded: Native.ComponentScope<Props> = Object.create(scope, {
      effect: { value: effect }, task: { value: task }, onDispose: { value: onDispose },
    });
    return setup(guarded, initial);
  });
}

/** Reloaded native action failures stay visible instead of terminating the host. */
export function Button(title: string, action: () => void, options?: Parameters<typeof Native.Button>[2]): Native.View {
  return Native.Button(title, () => {
    try {
      const result = (action as () => unknown)();
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(result).catch(report);
      }
    } catch (error) { report(error); }
  }, options);
}
function report(error: unknown): void {
  const callback = (globalThis as Record<symbol, unknown>)[Symbol.for('cosmurgy.reportError')];
  if (typeof callback === 'function') callback(error);
  else console.error(error instanceof Error ? error.message : String(error));
}
