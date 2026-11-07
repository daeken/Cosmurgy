import { Button, Component, Divider, ForEach, HStack, Image, Picker, ScrollView, Spacer,
  Text, TextEditor, TextField, View, VStack } from 'jonui';
import { cacheStatus, usageDetails } from './usage.ts';
import type { ShellHost } from './contracts.ts';

/** This entire module and its local imports can be replaced while a run continues. */
export function createShell(host: ShellHost): View {
  const Shell = Component(scope => {
    const showUsage = scope.state(false);
    const model = scope.state(host.workspace().model);
    const account = scope.state(host.activeAccount() ?? '');
    scope.effect(() => {
      host.revision.value;
      if (model.value !== host.workspace().model) model.value = host.workspace().model;
      if (account.value !== (host.activeAccount() ?? '')) account.value = host.activeAccount() ?? '';
    });
    scope.onDispose(model.subscribe(value => host.selectModel(value)));
    scope.onDispose(account.subscribe(value => { if (value && value !== host.activeAccount()) host.selectAccount(value); }));
    return () => {
      host.revision.value;
      const workspace = host.workspace(); const space = host.space(); const conversation = host.conversation();
      const busy = host.busy(); const accounts = host.accounts(); const models = host.models();
      const button = (title: string, action: () => void, id?: string) => {
        const result = Button(title, action); return id ? result.accessibilityIdentifier(id) : result;
      };
      const sidebar = VStack([
        HStack([Image({ systemName: 'sparkles' }), Text('Cosmurgy').font('title')], { spacing: 8 }),
        Text('A little shell, a little magic. ✨').font('caption').foregroundStyle('secondary'),
        Divider().padding({ top: 12, bottom: 8 }),
        HStack([Text('SPACES').font('caption').foregroundStyle('secondary'), Spacer(),
          button('+', host.addSpace, 'add-space')]),
        ScrollView(VStack([
          ForEach(workspace.spaces, { id: item => item.id }, item => VStack([
            button(`${item.id === space.id ? '●  ' : '○  '}${item.name}`, () => host.selectSpace(item.id), `space-${item.id}`),
            Text(item.maintainer).font('caption').foregroundStyle('secondary'),
          ], { alignment: 'leading', spacing: 4 }).padding({ top: 6, bottom: 8 })),
        ], { alignment: 'leading', spacing: 8 })),
        Divider(),
        HStack([Text('CONVERSATIONS').font('caption').foregroundStyle('secondary'), Spacer(),
          button('+', host.newConversation, 'new-conversation')]),
        ScrollView(VStack([
          ForEach(space.conversations, { id: item => item.id }, item =>
            button(`${item.id === conversation.id ? '› ' : ''}${item.title}`, () => host.selectConversation(item.id))),
        ], { alignment: 'leading', spacing: 8 })).frame({ minHeight: 80, maxHeight: 180 }),
        Spacer(), Divider(),
        ...(accounts.length ? [Picker('Account', { selection: account.binding,
          options: [{ value: '', label: 'Choose an account' }, ...accounts.map(item => ({ value: item.id, label: item.label }))] }),
          HStack([button('Add account', () => host.signIn()), button('Sign out', host.signOut).disabled(busy)]),
          button('ChatGPT usage ↗', host.openUsage)] : []),
        button(host.signingIn() ? 'Waiting for ChatGPT…' : 'Continue with ChatGPT', () => host.signIn(host.activeAccount() ?? undefined), 'connect-chatgpt')
          .disabled(host.signingIn() || busy),
        ...(host.signingIn() ? [button('Cancel sign-in', host.cancelSignIn)] : []),
        Text('Your conversations stay on this Mac.').font('caption').foregroundStyle('secondary'),
      ], { alignment: 'leading', spacing: 12 }).padding(20).frame({ width: 252 });

      const transcriptBody = VStack([
        ...(conversation.messages.length ? [ForEach(conversation.messages, { id: message => message.id }, message => {
          const label = message.role === 'user' ? 'YOU' : message.role === 'assistant' ? space.maintainer.toUpperCase()
            : message.role === 'tool' ? 'ACTIVITY' : 'COSMURGY';
          return VStack([
            Text(label).font('caption').foregroundStyle('secondary'),
            ...(message.role === 'tool' ? [button(message.text + (host.detail.value === message.id ? ' ▾' : ' ▸'), () => {
              host.detail.value = host.detail.value === message.id ? '' : message.id;
            })] : [Text(message.text || 'Thinking…').fixedSize({ horizontal: false, vertical: true })]),
            ...(host.detail.value === message.id && message.detail ? [Text(message.detail).font('caption').fixedSize({ horizontal: false, vertical: true })] : []),
            Divider().padding({ top: 10 }),
          ], { alignment: 'leading', spacing: 8 }).frame({ maxWidth: 'infinity', alignment: 'leading' }).padding({ bottom: 12 });
        })] : [
          Spacer({ minLength: 48 }), Image({ systemName: 'sparkles' }),
          Text('What should we make possible?').font('title'),
          Text('Talk with your maintainer. Build a space, shape this interface, or give the environment a new capability.')
            .foregroundStyle('secondary').fixedSize({ horizontal: false, vertical: true }),
          button('“Change something about your own shell.”', () => {
            host.draft.value = 'Read your shell source, then make a small visible improvement to it and reload it while keeping this conversation intact.';
          }),
          button('“Build me a new space.”', () => {
            host.draft.value = 'Create a small counter space with a native interface and a maintainer conversation. Make the counter persistent.';
          }),
        ]),
      ], { alignment: 'leading', spacing: 16 }).padding(20).frame({ maxWidth: 'infinity', alignment: 'leading' });
      let transcript: View;
      let needsScrollRestart = false;
      try { transcript = ScrollView(transcriptBody, { followBottom: true, scrollResetKey: conversation.id }); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes('Unknown')) throw error;
        needsScrollRestart = true;
        transcript = ScrollView(transcriptBody);
      }
      transcript = transcript.frame({ maxWidth: 'infinity', maxHeight: 'infinity' }).layoutPriority(1).accessibilityIdentifier('transcript');

      const canSend = () => !host.busy() && !!host.draft.value.trim() && !!host.activeAccount() && !!host.workspace().model;
      const send = () => { if (canSend()) host.send(); };
      let composer: View;
      let needsNativeRestart = false;
      try { composer = TextEditor({ text: host.draft.binding, onSubmit: send }); }
      catch (error) {
        // A hot shell reload can run in an older JonUI process. Preserve drafts
        // and keep the composer usable until the native launcher is restarted.
        if (!(error instanceof Error) || !error.message.includes('Unknown')) throw error;
        needsNativeRestart = true;
        composer = TextEditor({ text: host.draft.binding });
      }
      const content = VStack([
        HStack([VStack([Text(space.name).font('title'), Text(space.purpose).font('caption').foregroundStyle('secondary')], { alignment: 'leading', spacing: 4 }),
          Spacer(), button(host.workbench.value ? 'Close source' : 'Source', () => { host.workbench.value = !host.workbench.value; }, 'toggle-source'),
          button('Reload', host.reload, 'reload-shell').keyboardShortcut('r')]).fixedSize({ horizontal: false, vertical: true }).padding(16),
        Divider(),
        View(() => host.spaceView() ?? VStack([]), { fallback: error => VStack([
          Text(`Space view needs attention: ${String(error)}`), button('Reload space', host.reload),
        ], { alignment: 'leading', spacing: 8 }).padding() }),
        transcript,
        Divider(),
        VStack([
          HStack([Text(busy ? 'Working…' : conversation.run === 'interrupted' ? 'Ready to continue' : 'Message').font('caption').foregroundStyle('secondary'),
            Spacer(), ...(models.length ? [Picker('Model', { selection: model.binding,
              options: [{ value: '', label: 'Choose a model' }, ...models.map(item => ({ value: item.slug, label: item.name }))] }).disabled(busy)] : [])]).fixedSize({ horizontal: false, vertical: true }),
          composer.frame({ height: 48 }).accessibilityIdentifier('composer'),
          HStack([Text(needsNativeRestart || needsScrollRestart ? 'Relaunch to activate the native UI update.' : 'Enter to send · Shift-Enter for a newline').font('caption').foregroundStyle('secondary'), Spacer(),
            ...(busy ? [button('Stop', host.stop, 'stop-run')] : [button('Send', send, 'send-message')
              .keyboardShortcut('s').disabled(!canSend())])]).fixedSize({ horizontal: false, vertical: true }),
        ], { alignment: 'leading', spacing: 6 }).fixedSize({ horizontal: false, vertical: true }).padding({ top: 8, leading: 14, bottom: 8, trailing: 14 }).accessibilityIdentifier('composer-panel'),
      ], { alignment: 'leading', spacing: 0 }).frame({ minWidth: 480, maxWidth: 'infinity', maxHeight: 'infinity' });

      const workbench = VStack([
        HStack([Text('Living source').font('headline'), Spacer(), button('Save & reload', host.saveEditor, 'save-source')]),
        HStack([button('Shell', () => host.inspect('src/shell.ts')), button('Runtime', () => host.inspect('src/agent.ts')),
          button('Tools', () => host.inspect('src/tools/system.ts'))]),
        TextField('File path', { text: host.editorPath.binding }),
        TextEditor({ text: host.editor.binding, monospaced: true }).accessibilityIdentifier('source-editor'),
        Text('Edit the running environment. Saved changes become a new generation.').font('caption').foregroundStyle('secondary'),
        button('Restore previous shell', host.revertShell, 'revert-shell'),
      ], { alignment: 'leading', spacing: 12 }).padding(18).frame({ width: 440 });

      return VStack([
        HStack([sidebar, Divider(), content, ...(host.workbench.value ? [Divider(), workbench] : [])], { alignment: 'top', spacing: 0 })
          .frame({ maxWidth: 'infinity', maxHeight: 'infinity' }),
        Divider(),
        HStack([Text(host.status.value).font('caption').foregroundStyle('secondary'), Spacer(),
          button(cacheStatus(conversation), () => { showUsage.value = !showUsage.value; }, 'cache-usage').font('caption'),
          Text(`Generation ${host.generation()}`).font('caption').foregroundStyle('secondary')]).padding({ top: 7, leading: 18, bottom: 7, trailing: 18 }),
        ...(host.restartRequired?.value ? [Text(host.restartRequired.value).font('caption').foregroundStyle('secondary')
          .fixedSize({ horizontal: false, vertical: true }).padding({ leading: 18, trailing: 18, bottom: 8 }).accessibilityIdentifier('restart-required')] : []),
        ...(showUsage.value ? [Text(usageDetails(conversation)).font('caption').foregroundStyle('secondary')
          .fixedSize({ horizontal: false, vertical: true }).padding({ leading: 18, trailing: 18, bottom: 8 }).accessibilityIdentifier('cache-usage-details')] : []),
      ], { spacing: 0 });
    };
  });
  return Shell();
}
