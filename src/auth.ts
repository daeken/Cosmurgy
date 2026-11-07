import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { atomicJSON, readJSON } from './storage.ts';
import type { Account } from './contracts.ts';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const requestedScopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
interface Credential {
  id: string; subject: string; email: string; clientId: string;
  accessToken?: string; refreshToken?: string; idToken?: string;
  expiresAt: number; scopes: string[];
}
interface AuthData { hostId: string; active: string | null; accounts: Credential[] }
interface Tokens {
  access_token: string; refresh_token?: string; id_token?: string;
  expires_in: number; scope?: string; token_type: string;
}
interface AuthOptions {
  fetch?: typeof fetch;
  /** Test seams; production always uses OpenAI's issuer and verified JWKS. */
  authorizeUrl?: string;
  tokenUrl?: string;
  verify?: (token: string, audience: string) => Promise<JWTPayload>;
  timeoutMs?: number;
}
export class Auth {
  private data: AuthData;
  private path: string;
  private fetcher: typeof fetch;
  private verify: NonNullable<AuthOptions['verify']>;
  private pending?: { server: Server; cancel: () => void };
  private refreshing?: Promise<string>;
  private options: AuthOptions;
  constructor(directory: string, options: AuthOptions = {}) {
    this.options = options;
    this.path = join(directory, 'accounts.json');
    this.data = readJSON(this.path, () => ({ hostId: `urn:uuid:${randomUUID()}`, active: null, accounts: [] }));
    this.fetcher = options.fetch ?? fetch;
    const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    this.verify = options.verify ?? (async (token, audience) => (await jwtVerify(token, keys, { issuer, audience })).payload);
    this.save();
  }
  private save(): void { atomicJSON(this.path, this.data); }
  get activeId(): string | null { return this.data.active; }
  get signingIn(): boolean { return !!this.pending; }
  accounts(): Account[] {
    return this.data.accounts.map((account, index) => ({ id: account.id,
      label: `${account.email || 'ChatGPT account'} · ${index + 1}`, connected: !!account.accessToken }));
  }
  select(id: string): void {
    if (!this.data.accounts.some(a => a.id === id && a.accessToken)) throw new Error('Sign in to this account first.');
    this.data.active = id; this.save();
  }
  cancelLogin(): void { this.pending?.cancel(); }
  async login(open: (url: string) => void | Promise<void>, accountId?: string): Promise<void> {
    if (this.pending) throw new Error('A sign-in is already in progress.');
    const existing = accountId ? this.data.accounts.find(a => a.id === accountId) : undefined;
    if (accountId && !existing) throw new Error('Unknown ChatGPT account.');
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    let resolveCallback!: (url: URL) => void;
    let rejectCallback!: (error: Error) => void;
    let claimed = false;
    const callback = new Promise<URL>((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
    void callback.catch(() => {});
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/auth/callback') { response.writeHead(404).end(); return; }
      const received = Buffer.from(url.searchParams.get('state') ?? '');
      const expected = Buffer.from(state);
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
        response.writeHead(400).end('Invalid sign-in state. Return to Cosmurgy and try again.'); return;
      }
      if (claimed) { response.writeHead(409).end('This sign-in has already been received.'); return; }
      claimed = true;
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'" });
      response.end('<!doctype html><title>Cosmurgy</title><h1>Return to Cosmurgy</h1><p>Your sign-in is being verified. You can close this tab.</p>');
      resolveCallback(url);
    });
    const cancel = () => rejectCallback(new Error('Sign-in cancelled.'));
    this.pending = { server, cancel };
    const timer = setTimeout(() => rejectCallback(new Error('Sign-in timed out. Please try again.')), this.options.timeoutMs ?? 300_000);
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Could not start the sign-in callback.');
      const redirect = `http://127.0.0.1:${address.port}/auth/callback`;
      const url = new URL(this.options.authorizeUrl ?? `${issuer}/api/accounts/authorize`);
      url.search = new URLSearchParams({
        client_id: existing?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: this.data.hostId,
        response_type: 'code', redirect_uri: redirect, scope: requestedScopes, resource,
        state, nonce, code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        ...(!existing ? { agent_name_hint: 'Cosmurgy' } : {}),
        ...(existing?.idToken ? { id_token_hint: existing.idToken } : {}),
      }).toString();
      // URLs may contain an ID-token hint. Never log them.
      await open(url.href);
      const result = await callback;
      if (result.searchParams.has('error')) throw new Error('ChatGPT sign-in was declined. Please try again when ready.');
      const clientId = result.searchParams.get('client_id') ?? existing?.clientId;
      const code = result.searchParams.get('code');
      if (!code || !clientId || clientId === 'dynamic_agent_client') throw new Error('Incomplete ChatGPT registration. Please sign in again.');
      if (existing && clientId !== existing.clientId) throw new Error('The returned registration did not match the selected account.');
      const tokens = await this.exchange({ grant_type: 'authorization_code', client_id: clientId,
        code, code_verifier: verifier, redirect_uri: redirect, resource });
      if (!tokens.id_token) throw new Error('ChatGPT did not return an identity token.');
      const identity = await this.verify(tokens.id_token, clientId);
      if (!identity.sub || identity.nonce !== nonce) throw new Error('ChatGPT identity verification failed.');
      if (existing && existing.subject !== identity.sub) throw new Error('This sign-in belongs to a different account. Add it separately.');
      const scopes = (tokens.scope ?? '').split(' ');
      if (!scopes.includes('chatgpt.tokens.use.direct') || !scopes.includes('resource.invoke')) {
        throw new Error('ChatGPT plan access was not granted. Sign in again and allow plan usage.');
      }
      const credential: Credential = { id: existing?.id ?? randomUUID(), subject: identity.sub,
        email: typeof identity.email === 'string' ? identity.email : '', clientId,
        accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token,
        expiresAt: Date.now() + tokens.expires_in * 1000, scopes };
      const index = this.data.accounts.findIndex(a => a.id === credential.id);
      if (index === -1) this.data.accounts.push(credential); else this.data.accounts[index] = credential;
      this.data.active = credential.id; this.save();
    } finally {
      clearTimeout(timer); server.close(); this.pending = undefined;
      // If opening the browser failed before awaiting the callback, consume cancellation.
      void callback.catch(() => {});
    }
  }
  private async exchange(body: Record<string, string>): Promise<Tokens> {
    const response = await this.fetcher(this.options.tokenUrl ?? `${issuer}/api/accounts/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`ChatGPT authorization failed (${response.status}). Please sign in again.`);
    const tokens = await response.json() as Tokens;
    if (!tokens.access_token || !Number.isFinite(tokens.expires_in) || tokens.token_type?.toLowerCase() !== 'bearer') {
      throw new Error('ChatGPT returned an incomplete token response.');
    }
    return tokens;
  }
  async token(forceRefresh = false): Promise<string> {
    const account = this.data.accounts.find(a => a.id === this.data.active);
    if (!account?.accessToken) throw new Error('Continue with ChatGPT to connect your subscription.');
    if (!forceRefresh && account.expiresAt > Date.now() + 60_000) return account.accessToken;
    if (!account.refreshToken) throw new Error('Your ChatGPT session has expired. Sign in again.');
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const tokens = await this.exchange({ grant_type: 'refresh_token', client_id: account.clientId,
        refresh_token: account.refreshToken!, resource });
      const scopes = tokens.scope ? tokens.scope.split(' ') : account.scopes;
      if (!scopes.includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT plan access was revoked. Sign in again.');
      account.accessToken = tokens.access_token;
      account.refreshToken = tokens.refresh_token ?? account.refreshToken;
      account.expiresAt = Date.now() + tokens.expires_in * 1000;
      account.scopes = scopes;
      this.save(); return account.accessToken;
    })();
    try { return await this.refreshing; } finally { this.refreshing = undefined; }
  }
  async logout(): Promise<void> {
    const account = this.data.accounts.find(a => a.id === this.data.active);
    if (!account) return;
    let revoked = true;
    try {
      if (account.refreshToken) {
        const discovery = await this.fetcher(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
        const metadata = await discovery.json() as { revocation_endpoint: string };
        const endpoint = new URL(metadata.revocation_endpoint);
        if (endpoint.origin !== issuer) throw new Error('Invalid revocation endpoint.');
        const response = await this.fetcher(endpoint, { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10_000),
          body: new URLSearchParams({ token: account.refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId }) });
        revoked = response.ok;
      }
    } catch { revoked = false; }
    delete account.accessToken; delete account.refreshToken; delete account.idToken;
    account.expiresAt = 0; this.data.active = null; this.save();
    if (!revoked) throw new Error('Signed out locally. Remote revocation was not confirmed; you can disconnect Cosmurgy in ChatGPT Settings.');
  }
  dispose(): void { this.cancelLogin(); }
}
