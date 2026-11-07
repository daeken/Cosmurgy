import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { Auth } from '../src/auth.ts';

async function setup(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cosmurgy-auth-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = await generateKeyPair('RS256');
  let authorization!: URL;
  let nonceOverride: string | undefined; let subject = 'user-one'; let scopes = 'openid resource.invoke chatgpt.tokens.use.direct';
  let refreshes = 0;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith('openid-configuration')) return Response.json({ revocation_endpoint: 'https://auth.openai.com/revoke' });
    if (String(url).endsWith('/revoke')) return new Response('', { status: 200 });
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('resource'), 'https://api.openai.com/v1');
    assert.equal(body.get('client_id'), 'issued-test-client');
    if (body.get('grant_type') === 'refresh_token') {
      refreshes++; assert.equal(body.get('refresh_token'), 'refresh-test-only');
      await new Promise(resolve => setTimeout(resolve, 15));
    } else {
      assert.equal(body.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
      assert.ok(body.get('code_verifier')); assert.equal(body.get('code'), 'test-code');
    }
    const token = await new SignJWT({ nonce: nonceOverride ?? authorization.searchParams.get('nonce'), email: 'test@example.com' })
      .setProtectedHeader({ alg: 'RS256' }).setIssuer('https://auth.openai.com').setAudience('issued-test-client')
      .setSubject(subject).setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
    return Response.json({ access_token: 'test-access-only', refresh_token: 'refresh-test-only', id_token: token,
      token_type: 'Bearer', expires_in: 3600, scope: scopes });
  };
  const auth = new Auth(directory, { fetch: fetcher,
    verify: async (token, audience) => (await jwtVerify(token, keys.publicKey, { issuer: 'https://auth.openai.com', audience })).payload });
  t.after(() => auth.dispose());
  async function open(url: string) {
    authorization = new URL(url);
    assert.equal(authorization.origin, 'https://auth.openai.com');
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.match(authorization.searchParams.get('ext_agent_host_id')!, /^urn:uuid:/);
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({ code: 'test-code', state: authorization.searchParams.get('state')!, client_id: 'issued-test-client' }).toString();
    assert.equal((await fetch(callback)).status, 200);
  }
  return { auth, directory, open, authorization: () => authorization, refreshes: () => refreshes,
    setNonce(value: string) { nonceOverride = value; }, setSubject(value: string) { subject = value; }, setScopes(value: string) { scopes = value; } };
}
test('OAuth uses PKCE, verifies identity and saves protected credentials separately from workspace data', async t => {
  const { auth, directory, open, authorization } = await setup(t);
  await auth.login(open);
  assert.equal(authorization().searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(authorization().searchParams.get('agent_name_hint'), 'Cosmurgy');
  assert.equal(await auth.token(), 'test-access-only'); assert.equal(auth.accounts().length, 1);
  assert.equal((await stat(join(directory, 'accounts.json'))).mode & 0o777, 0o600);
  assert.equal(auth.signingIn, false);
});
test('returning sign-in reuses the issued registration and stable host ID', async t => {
  const { auth, directory, open, authorization } = await setup(t);
  await auth.login(open); const host = authorization().searchParams.get('ext_agent_host_id'); const id = auth.activeId!;
  await auth.login(open, id);
  assert.equal(authorization().searchParams.get('client_id'), 'issued-test-client');
  assert.equal(authorization().searchParams.has('agent_name_hint'), false);
  assert.ok(authorization().searchParams.get('id_token_hint'));
  assert.equal(authorization().searchParams.get('ext_agent_host_id'), host);
  assert.equal(auth.accounts().length, 1);
  assert.equal(new Auth(directory).activeId, id);
});
test('a callback with the wrong state cannot complete or consume the login', async t => {
  const { auth, open } = await setup(t);
  await auth.login(async url => {
    const authorize = new URL(url); const callback = new URL(authorize.searchParams.get('redirect_uri')!);
    callback.search = '?state=wrong&code=stolen';
    assert.equal((await fetch(callback)).status, 400); await open(url);
  });
  assert.ok(auth.activeId);
});
test('nonce mismatch or missing plan scopes never activates an account', async t => {
  const first = await setup(t); first.setNonce('wrong'); await assert.rejects(first.auth.login(first.open), /verification/);
  assert.equal(first.auth.activeId, null);
  const second = await setup(t); second.setScopes('openid'); await assert.rejects(second.auth.login(second.open), /plan access was not granted/);
  assert.equal(second.auth.activeId, null);
});
test('returning authorization cannot replace an account with another identity', async t => {
  const { auth, open, setSubject } = await setup(t);
  await auth.login(open); const id = auth.activeId!;
  setSubject('other-user'); await assert.rejects(auth.login(open, id), /different account/);
  assert.equal(auth.activeId, id); assert.equal(auth.accounts().length, 1);
});
test('concurrent refreshes are serialized and persisted together', async t => {
  const { auth, open, refreshes, directory } = await setup(t); await auth.login(open);
  assert.deepEqual(await Promise.all([auth.token(true), auth.token(true)]), ['test-access-only', 'test-access-only']);
  assert.equal(refreshes(), 1);
  const saved = JSON.parse(await readFile(join(directory, 'accounts.json'), 'utf8'));
  assert.equal(saved.accounts[0].refreshToken, 'refresh-test-only');
});
test('sign-out clears tokens but retains the issued registration and host', async t => {
  const { auth, open, directory } = await setup(t); await auth.login(open); const id = auth.activeId;
  await auth.logout(); assert.equal(auth.activeId, null); assert.equal(auth.accounts()[0].connected, false);
  await assert.rejects(auth.token(), /Continue with ChatGPT/);
  const saved = JSON.parse(await readFile(join(directory, 'accounts.json'), 'utf8'));
  assert.equal(saved.accounts[0].id, id); assert.equal(saved.accounts[0].clientId, 'issued-test-client');
  assert.equal(saved.accounts[0].accessToken, undefined); assert.equal(saved.accounts[0].idToken, undefined);
});
test('cancelling browser sign-in closes the listener and leaves credentials untouched', async t => {
  const { auth } = await setup(t);
  let callback!: URL;
  const pending = auth.login(url => { callback = new URL(new URL(url).searchParams.get('redirect_uri')!); auth.cancelLogin(); });
  await assert.rejects(pending, /cancelled/); assert.equal(auth.signingIn, false); assert.equal(auth.activeId, null);
  await assert.rejects(fetch(callback));
});
