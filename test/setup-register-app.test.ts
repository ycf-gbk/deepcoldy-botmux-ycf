/**
 * 单测 src/setup/register-app.ts — device-code PersonalAgent 注册流.
 *
 * Run: pnpm vitest run test/setup-register-app.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';

vi.mock('qrcode-terminal', () => ({
  default: { generate: (_: string, _opts: unknown, cb?: (q: string) => void) => cb?.('FAKE-QR') },
}));

import { tryRegisterApp } from '../src/setup/register-app.js';

type Call = {
  url: string;
  body: Record<string, string>;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function parseFormBody(init?: RequestInit): Record<string, string> {
  const body = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
  return Object.fromEntries(new URLSearchParams(body).entries()) as Record<string, string>;
}

function createRegisterAppFetch(opts: {
  initBody?: unknown;
  beginBody?: unknown;
  pollBodies: Array<{ body: unknown; status?: number }>;
  tokenBody?: unknown;
  botBody?: unknown;
}) {
  const calls: Call[] = [];
  let pollIndex = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = parseFormBody(init);
    calls.push({ url, body });

    if (url.includes('/oauth/v1/app/registration')) {
      if (body.action === 'init') return jsonResponse(opts.initBody ?? { supported_auth_methods: ['client_secret'] });
      if (body.action === 'begin') return jsonResponse(opts.beginBody ?? {
        device_code: 'device-code',
        verification_uri_complete: 'https://accounts.feishu.cn/verify',
        user_code: 'ABCD-EFGH',
        interval: 0,
        expire_in: 600,
      });
      if (body.action === 'poll') {
        const next = opts.pollBodies[Math.min(pollIndex, opts.pollBodies.length - 1)];
        pollIndex += 1;
        return jsonResponse(next?.body ?? {}, next?.status ?? 200);
      }
      throw new Error(`unexpected registration action: ${body.action ?? '<missing>'}`);
    }

    if (url.includes('/open-apis/auth/v3/tenant_access_token/internal')) {
      return jsonResponse(opts.tokenBody ?? { code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
    }

    if (url.includes('/open-apis/bot/v3/info')) {
      return jsonResponse(opts.botBody ?? {
        code: 0,
        bot: { open_id: 'bot_open_id', app_name: 'Botmux Bot' },
      });
    }

    throw new Error(`unexpected url: ${url}`);
  });

  return { calls, fetchMock };
}

describe('tryRegisterApp', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns appId, appSecret, bot info, and appends hermes tracking to the QR URL', async () => {
    const { fetchMock, calls } = createRegisterAppFetch({
      beginBody: {
        device_code: 'device-code',
        verification_uri_complete: 'https://accounts.feishu.cn/verify?foo=1',
        user_code: 'ABCD-EFGH',
        interval: 0,
        expire_in: 600,
      },
      pollBodies: [
        {
          body: {
            client_id: 'cli_test_feishu',
            client_secret: 'secret-feishu-xxx',
            user_info: { tenant_brand: 'feishu', open_id: 'ou_abc123' },
          },
        },
      ],
      tokenBody: { code: 0, tenant_access_token: 't-xxx', expire: 7200 },
      botBody: { code: 0, bot: { open_id: 'bot_123', app_name: 'Bot Name' } },
    });
    const qrCalls: Array<{ url: string; expireIn: number }> = [];
    const statusCalls: Array<{ status: string; interval?: number }> = [];

    const result = await tryRegisterApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      onQRCodeReady: info => qrCalls.push(info),
      onStatusChange: info => statusCalls.push(info),
    });

    expect(result).toEqual({
      ok: true,
      appId: 'cli_test_feishu',
      appSecret: 'secret-feishu-xxx',
      brand: 'feishu',
      userOpenId: 'ou_abc123',
      botOpenId: 'bot_123',
      botName: 'Bot Name',
    });
    expect(qrCalls).toHaveLength(1);
    const qrUrl = new URL(qrCalls[0]!.url);
    expect(qrUrl.searchParams.get('foo')).toBe('1');
    expect(qrUrl.searchParams.get('from')).toBe('hermes');
    expect(qrUrl.searchParams.get('tp')).toBe('hermes');
    expect(qrUrl.searchParams.get('createOnly')).toBe('true');
    const addons = JSON.parse(
      gunzipSync(Buffer.from(qrUrl.searchParams.get('addons')!, 'base64url')).toString('utf8'),
    );
    expect(addons.scopes.tenant).toEqual(expect.arrayContaining([
      'im:message',
      'im:message.group_msg',
      'im:chat.members:read',
      'im:chat.members:write_only',
      'contact:user.base:readonly',
    ]));
    expect(addons.scopes.tenant).toContain('contact:user.id:readonly');
    expect(addons.events.items.tenant).toContain('im.message.receive_v1');
    expect(addons.callbacks.items).toContain('card.action.trigger');
    expect(qrCalls[0]!.expireIn).toBe(600);
    expect(statusCalls).toEqual([]);

    expect(calls.filter(call => call.body.action).map(call => call.body.action)).toEqual(['init', 'begin', 'poll']);
    expect(calls[0]!.url).toContain('accounts.feishu.cn/oauth/v1/app/registration');
    expect(calls[1]!.body).toMatchObject({
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id',
    });
    expect(calls[2]!.body).toMatchObject({
      action: 'poll',
      device_code: 'device-code',
      tp: 'ob_app',
    });
    expect(calls[3]!.url).toContain('open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal');
    expect(calls[4]!.url).toContain('open.feishu.cn/open-apis/bot/v3/info');
  });

  it('switches to the lark host once poll reports tenant_brand=lark', async () => {
    const { fetchMock, calls } = createRegisterAppFetch({
      pollBodies: [
        {
          status: 400,
          body: {
            error: 'authorization_pending',
            user_info: { tenant_brand: 'lark' },
          },
        },
        {
          body: {
            client_id: 'cli_test_lark',
            client_secret: 'secret-lark-xxx',
            user_info: { tenant_brand: 'lark', open_id: 'ou_lark_123' },
          },
        },
      ],
      tokenBody: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      botBody: { code: 0, bot: { open_id: 'bot_lark_123', bot_name: 'Lark Bot' } },
    });
    const statusCalls: Array<{ status: string; interval?: number }> = [];

    const result = await tryRegisterApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      onQRCodeReady: () => {},
      onStatusChange: info => statusCalls.push(info),
    });

    expect(result).toMatchObject({
      ok: true,
      brand: 'lark',
      appId: 'cli_test_lark',
      userOpenId: 'ou_lark_123',
      botOpenId: 'bot_lark_123',
      botName: 'Lark Bot',
    });
    expect(statusCalls).toEqual([{ status: 'domain_switched' }]);

    const pollCalls = calls.filter(call => call.body.action === 'poll');
    expect(pollCalls).toHaveLength(2);
    expect(pollCalls[0]!.url).toContain('accounts.feishu.cn/oauth/v1/app/registration');
    expect(pollCalls[1]!.url).toContain('accounts.larksuite.com/oauth/v1/app/registration');
    expect(calls[4]!.url).toContain('open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal');
    expect(calls[5]!.url).toContain('open.larksuite.com/open-apis/bot/v3/info');
  });

  it('returns denied when poll body reports access_denied', async () => {
    const { fetchMock } = createRegisterAppFetch({
      pollBodies: [{ status: 400, body: { error: 'access_denied' } }],
    });

    const result = await tryRegisterApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      onQRCodeReady: () => {},
      onStatusChange: () => {},
    });

    expect(result).toEqual({
      ok: false,
      error: 'denied',
      message: '用户在浏览器里拒绝授权',
    });
  });

  it('returns expired when poll body reports expired_token', async () => {
    const { fetchMock } = createRegisterAppFetch({
      pollBodies: [{ status: 400, body: { error: 'expired_token' } }],
    });

    const result = await tryRegisterApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      onQRCodeReady: () => {},
      onStatusChange: () => {},
    });

    expect(result).toEqual({
      ok: false,
      error: 'expired',
      message: '二维码已过期, 请重试',
    });
  });

  it('returns unknown with appId when probe fails after registration succeeds', async () => {
    const { fetchMock } = createRegisterAppFetch({
      pollBodies: [
        {
          body: {
            client_id: 'cli_probe_fail',
            client_secret: 'secret-probe-fail',
            user_info: { tenant_brand: 'feishu', open_id: 'ou_probe' },
          },
        },
      ],
      tokenBody: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      botBody: { code: 1, msg: 'bot probe failed abcdefghijklmnopqrstuvwxyz1234567890' },
    });

    const result = await tryRegisterApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      onQRCodeReady: () => {},
      onStatusChange: () => {},
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'unknown',
      appId: 'cli_probe_fail',
      brand: 'feishu',
    });
    if (!result.ok) {
      expect(result.message).toContain('bot/v3/info failed');
      expect(result.message).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
    }
  });

  it('returns unknown when init does not advertise client_secret', async () => {
    const { fetchMock } = createRegisterAppFetch({
      initBody: { supported_auth_methods: ['password'] },
      pollBodies: [],
    });

    const result = await tryRegisterApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      onQRCodeReady: () => {},
      onStatusChange: () => {},
    });

    expect(result).toEqual({
      ok: false,
      error: 'unknown',
      message: '当前区域不支持 client_secret 认证',
    });
  });

  it('classifies fetch failures as network errors', async () => {
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:443'), { code: 'ETIMEDOUT' });
    });

    const result = await tryRegisterApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      onQRCodeReady: () => {},
      onStatusChange: () => {},
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'network',
      message: expect.stringContaining('网络错误'),
    });
  });

  it('preserves appId when the post-registration probe throws a network error', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/oauth/v1/app/registration')) {
        const body = parseFormBody(init);
        if (body.action === 'init') return jsonResponse({ supported_auth_methods: ['client_secret'] });
        if (body.action === 'begin') return jsonResponse({
          device_code: 'device-code',
          verification_uri_complete: 'https://accounts.feishu.cn/verify',
          interval: 0,
          expire_in: 600,
        });
        if (body.action === 'poll') return jsonResponse({
          client_id: 'cli_probe_network_fail',
          client_secret: 'secret-probe-network-fail',
          user_info: { tenant_brand: 'feishu' },
        });
        throw new Error(`unexpected action: ${body.action}`);
      }
      if (url.includes('/open-apis/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
      }
      if (url.includes('/open-apis/bot/v3/info')) {
        throw Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
      }
      throw Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
    });

    const result = await tryRegisterApp({
      fetchImpl: fetchMock as unknown as typeof fetch,
      onQRCodeReady: () => {},
      onStatusChange: () => {},
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'network',
      appId: 'cli_probe_network_fail',
      brand: 'feishu',
    });
  });
});
