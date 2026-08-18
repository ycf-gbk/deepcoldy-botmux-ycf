/**
 * 飞书 / Lark 扫码创建 PersonalAgent 应用。
 *
 * 这条路径走 accounts 域的 device-code 注册通道:
 *   1. `action=init` 检查当前区域是否支持 `client_secret`
 *   2. `action=begin` + `archetype=PersonalAgent` 发起注册并拿二维码
 *   3. `action=poll` 轮询到返回 `client_id` / `client_secret`
 *   4. 用刚拿到的凭证换 `tenant_access_token` 再 probe `/bot/v3/info`
 *
 * 拿到的凭证会直接返回给上层, 不在这里写盘. 失败只返回结构化错误,
 * 不抛异常, 方便 CLI / Dashboard 统一做降级处理。
 */
import qrcode from 'qrcode-terminal';
import { gzipSync } from 'node:zlib';
import { larkHosts, type Brand } from '../im/lark/lark-hosts.js';
import { BOTMUX_REQUIRED_SCOPES, validateCredentials } from './verify-permissions.js';

export type RegisterBrand = Brand;

export type RegisterAppOk = {
  ok: true;
  appId: string;
  appSecret: string;
  brand: RegisterBrand;
  /**
   * 扫码人的 open_id（设备码注册返回的 `user_info.open_id`）。
   * 它只是 owner candidate：必须由目标应用验证并尽量转换为 union_id 后才能持久化。
   */
  userOpenId?: string;
  /** 通过 `/bot/v3/info` 探测到的机器人 open_id。 */
  botOpenId?: string;
  /** 通过 `/bot/v3/info` 探测到的机器人名称。 */
  botName?: string;
};

export type RegisterAppErr = {
  ok: false;
  /**
   * - `aborted`: 用户取消 / 外部信号中止
   * - `expired`: 二维码过期
   * - `denied`: 用户拒绝授权
   * - `network`: 网络错误 / 端点不可达
   * - `unknown`: 其它错误
   */
  error: 'aborted' | 'expired' | 'denied' | 'network' | 'unknown';
  /** 给用户看的简短错误描述, 不含 secret。 */
  message: string;
  /**
   * 如果注册已成功但后续 probe 失败, 这里会带回 appId,
   * 方便上层避免重复创建。
   */
  appId?: string;
  brand?: RegisterBrand;
};

export type RegisterAppResult = RegisterAppOk | RegisterAppErr;

export interface RegisterAppOptions {
  /** 取消信号 (Ctrl-C 时填充). */
  signal?: AbortSignal;
  /**
   * 渲染前回调, 测试时可注入静默打印. 默认在 stdout 打印二维码 + 链接。
   */
  onQRCodeReady?: (info: { url: string; expireIn: number }) => void;
  /** 状态变更回调, 主要用于"已切换到 Lark 域名"提示。 */
  onStatusChange?: (info: { status: string; interval?: number }) => void;
  /** 测试注入用 fetch 实现, 默认使用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

const REGISTRATION_PATH = '/oauth/v1/app/registration';

const BOTMUX_REGISTRATION_EVENTS = [
  'im.message.receive_v1',
  'im.chat.member.bot.added_v1',
  'im.chat.member.bot.deleted_v1',
  'drive.notice.comment_add_v1',
  'im.message.reaction.created_v1',
  'im.message.reaction.deleted_v1',
  'im.chat.member.user.added_v1',
  'im.chat.member.user.deleted_v1',
] as const;

/** Public device-flow addons; event mode and callback URLs need later config. */
export function buildRegistrationAddons() {
  return {
    scopes: {
      tenant: [
        ...new Set([
          ...BOTMUX_REQUIRED_SCOPES.map(scope => scope.name),
          'contact:user.id:readonly',
        ]),
      ],
    },
    events: { items: { tenant: [...BOTMUX_REGISTRATION_EVENTS] } },
    callbacks: { items: ['card.action.trigger'] },
  };
}

function encodeRegistrationAddons(): string {
  return gzipSync(Buffer.from(JSON.stringify(buildRegistrationAddons()), 'utf8'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function defaultPrintQRCode(info: { url: string; expireIn: number }): void {
  const mins = Math.max(1, Math.round(info.expireIn / 60));
  process.stderr.write('\n请用飞书 App 扫码完成应用创建：\n\n');
  qrcode.generate(info.url, { small: true }, (qr) => process.stderr.write(qr + '\n'));
  process.stderr.write(`\n二维码有效期约 ${mins} 分钟。也可在浏览器打开：\n  ${info.url}\n\n`);
}

function defaultPrintStatus(info: { status: string; interval?: number }): void {
  if (info.status === 'domain_switched') {
    process.stderr.write('识别到国际版租户, 已切换到 larksuite.com 域名继续轮询。\n');
  } else if (info.status === 'slow_down' && info.interval) {
    process.stderr.write(`轮询过快, 间隔自动调整到 ${info.interval}s。\n`);
  }
}

function redactLongTokens(value: string): string {
  return value.replace(/[a-zA-Z0-9_-]{30,}/g, '***');
}

function safeMessage(err: unknown): string {
  if (err && typeof err === 'object' && !(err instanceof Error)) {
    try {
      return redactLongTokens(JSON.stringify(err));
    } catch {
      return redactLongTokens(String(err));
    }
  }
  const raw =
    err instanceof Error
      ? `${err.message}${err.name && err.name !== 'Error' ? ` (${err.name})` : ''}`
      : typeof err === 'string'
        ? err
        : String(err);
  return redactLongTokens(raw);
}

function isAbortError(err: unknown): boolean {
  return Boolean(
    err
    && typeof err === 'object'
    && ('name' in err ? (err as { name?: unknown }).name === 'AbortError' : false),
  );
}

function isNetworkError(err: unknown): boolean {
  const msg = safeMessage(err);
  return /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET|network/i.test(msg);
}

function toObject(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function appendHermesTracking(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('from', 'hermes');
    parsed.searchParams.set('tp', 'hermes');
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}from=hermes&tp=hermes`;
  }
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function waitForNextPoll(seconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, seconds * 1000);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
  });
}

async function postRegistrationAction(
  fetcher: typeof fetch,
  accountsHost: string,
  body: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ response: Response; body: unknown }> {
  const response = await fetcher(`${accountsHost}${REGISTRATION_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(body).toString(),
    signal,
  });
  return { response, body: await readJsonBody(response) };
}

/**
 * 扫码创建 PersonalAgent 应用. 任何失败都返回 RegisterAppErr (不抛).
 */
export async function tryRegisterApp(opts: RegisterAppOptions = {}): Promise<RegisterAppResult> {
  const onQR = opts.onQRCodeReady ?? defaultPrintQRCode;
  const onStatus = opts.onStatusChange ?? defaultPrintStatus;
  const fetcher = opts.fetchImpl ?? fetch;
  let registeredAppId: string | undefined;
  let registeredBrand: RegisterBrand | undefined;

  try {
    let brand: RegisterBrand = 'feishu';
    let accountsHost = larkHosts(brand).accounts;

    const init = await postRegistrationAction(fetcher, accountsHost, { action: 'init' }, opts.signal);
    const initBody = toObject(init.body);
    const supportedMethods = Array.isArray(initBody?.supported_auth_methods)
      ? initBody.supported_auth_methods
      : [];
    if (!supportedMethods.includes('client_secret')) {
      return {
        ok: false,
        error: 'unknown',
        message: '当前区域不支持 client_secret 认证',
      };
    }

    const begin = await postRegistrationAction(
      fetcher,
      accountsHost,
      {
        action: 'begin',
        archetype: 'PersonalAgent',
        auth_method: 'client_secret',
        request_user_info: 'open_id',
      },
      opts.signal,
    );
    const beginBody = toObject(begin.body);
    const deviceCode = typeof beginBody?.device_code === 'string' ? beginBody.device_code : '';
    const verificationUri = typeof beginBody?.verification_uri_complete === 'string'
      ? beginBody.verification_uri_complete
      : typeof beginBody?.verification_uri === 'string'
        ? beginBody.verification_uri
        : '';
    if (!deviceCode || !verificationUri) {
      return {
        ok: false,
        error: 'unknown',
        message: '注册开始返回缺少 device_code 或 verification_uri_complete',
      };
    }

    const intervalSeconds = Math.max(0, toNumber(beginBody?.interval, 5));
    const expireIn = Math.max(1, toNumber(beginBody?.expire_in, 600));
    const qrUrl = new URL(appendHermesTracking(verificationUri));
    qrUrl.searchParams.set('addons', encodeRegistrationAddons());
    qrUrl.searchParams.set('createOnly', 'true');
    onQR({ url: qrUrl.toString(), expireIn });

    let pollIntervalSeconds = intervalSeconds;
    const deadline = Date.now() + expireIn * 1000;
    let userOpenId: string | undefined;

    for (;;) {
      if (opts.signal?.aborted) {
        return { ok: false, error: 'aborted', message: '用户取消扫码' };
      }
      if (Date.now() >= deadline) {
        return { ok: false, error: 'expired', message: '二维码已过期, 请重试' };
      }

      const poll = await postRegistrationAction(
        fetcher,
        accountsHost,
        {
          action: 'poll',
          device_code: deviceCode,
          tp: 'ob_app',
        },
        opts.signal,
      );
      const pollBody = toObject(poll.body);
      const userInfo = toObject(pollBody?.user_info);
      if (userInfo?.tenant_brand === 'lark' && brand !== 'lark') {
        brand = 'lark';
        accountsHost = larkHosts(brand).accounts;
        onStatus({ status: 'domain_switched' });
      }

      const clientId = typeof pollBody?.client_id === 'string' ? pollBody.client_id : undefined;
      const clientSecret = typeof pollBody?.client_secret === 'string' ? pollBody.client_secret : undefined;
      if (clientId && clientSecret) {
        registeredAppId = clientId;
        registeredBrand = brand;
        if (typeof userInfo?.open_id === 'string' && userInfo.open_id.startsWith('ou_')) {
          userOpenId = userInfo.open_id;
        }

        const validation = await validateCredentials(clientId, clientSecret, brand, {
          fetchImpl: fetcher,
          signal: opts.signal,
        });
        if (!validation.ok) {
          return {
            ok: false,
            error: validation.error === 'network' ? 'network' : 'unknown',
            message: redactLongTokens(`tenant_access_token 校验失败: ${validation.message}`),
            appId: clientId,
            brand,
          };
        }

        const probeRes = await fetcher(`${larkHosts(brand).openApi}/open-apis/bot/v3/info`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${validation.tenantAccessToken}` },
          signal: opts.signal,
        });
        const probeBody = await readJsonBody(probeRes);
        const probeData = toObject(probeBody);
        if (!probeRes.ok || !probeData || typeof probeData.code !== 'number' || probeData.code !== 0) {
          return {
            ok: false,
            error: 'unknown',
            message: redactLongTokens(`bot/v3/info failed: ${probeData?.msg ?? probeData?.message ?? `HTTP ${probeRes.status}`}`),
            appId: clientId,
            brand,
          };
        }

        const bot = toObject(probeData.bot);
        const botOpenId = typeof bot?.open_id === 'string' ? bot.open_id : undefined;
        const botName = typeof bot?.app_name === 'string'
          ? bot.app_name
          : typeof bot?.bot_name === 'string'
            ? bot.bot_name
            : undefined;

        return {
          ok: true,
          appId: clientId,
          appSecret: clientSecret,
          brand,
          ...(userOpenId ? { userOpenId } : {}),
          ...(botOpenId ? { botOpenId } : {}),
          ...(botName ? { botName } : {}),
        };
      }

      const error = typeof pollBody?.error === 'string' ? pollBody.error : undefined;
      if (error === 'authorization_pending') {
        await waitForNextPoll(pollIntervalSeconds, opts.signal);
        continue;
      }
      if (error === 'slow_down') {
        pollIntervalSeconds += 5;
        onStatus({ status: 'slow_down', interval: pollIntervalSeconds });
        await waitForNextPoll(pollIntervalSeconds, opts.signal);
        continue;
      }
      if (error === 'access_denied') {
        return { ok: false, error: 'denied', message: '用户在浏览器里拒绝授权' };
      }
      if (error === 'expired_token') {
        return { ok: false, error: 'expired', message: '二维码已过期, 请重试' };
      }
      if (error) {
        return { ok: false, error: 'unknown', message: redactLongTokens(`注册轮询失败: ${error}`) };
      }

      // 兼容 body 没带 error 但也没给凭证的异常响应。
      return {
        ok: false,
        error: 'unknown',
        message: redactLongTokens(`注册轮询响应缺少 client_id/client_secret: ${safeMessage(pollBody)}`),
      };
    }
  } catch (err: any) {
    if (isAbortError(err)) {
      return {
        ok: false,
        error: 'aborted',
        message: '用户取消扫码',
        ...(registeredAppId ? { appId: registeredAppId } : {}),
        ...(registeredBrand ? { brand: registeredBrand } : {}),
      };
    }
    if (isNetworkError(err)) {
      return {
        ok: false,
        error: 'network',
        message: `网络错误: ${safeMessage(err)}`,
        ...(registeredAppId ? { appId: registeredAppId } : {}),
        ...(registeredBrand ? { brand: registeredBrand } : {}),
      };
    }
    return {
      ok: false,
      error: 'unknown',
      message: safeMessage(err),
      ...(registeredAppId ? { appId: registeredAppId } : {}),
      ...(registeredBrand ? { brand: registeredBrand } : {}),
    };
  }
}
