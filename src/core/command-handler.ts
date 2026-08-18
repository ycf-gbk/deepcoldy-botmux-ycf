/**
 * Command handler — processes /slash commands from users.
 * Extracted from daemon.ts for modularity.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { config } from '../config.js';
import { buildTerminalUrl } from './terminal-url.js';
import { getBot, getAllBots, getBotOpenId, getOwnerOpenId, findOncallChat, effectiveDefaultWorkingDir } from '../bot-registry.js';
import { readGlobalConfig, repoPickerScanOptions } from '../global-config.js';
import * as sessionStore from '../services/session-store.js';
import * as scheduleStore from '../services/schedule-store.js';
import * as scheduler from './scheduler.js';
import { scanProjects, scanMultipleProjects, describeProjectDir } from '../services/project-scanner.js';
import { createRepoWorktree, pushWorktreeBranch } from '../services/git-worktree.js';
import { worktreeSlugFromContextAI } from '../services/worktree-slug-ai.js';
import { isRiffBackendSession, resolvePairedSpawnBackendType } from './persistent-backend.js';
import { buildRepoSelectCard, buildAdoptSelectCard, buildCodexAppThreadSelectCard, buildSlashListCard, getCliDisplayName, buildConfigCard, buildForkPanelCard, buildAdoptBlockedCard } from '../im/lark/card-builder.js';
import { handleDashboardCommand } from './dashboard-command/index.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import type { CliId, ResumableSession } from '../adapters/cli/types.js';
import { resolveCliRuntime, runtimeInstallationKey } from '../adapters/cli/runtime.js';
import { deleteMessage, sendMessage, sendUserMessage, replyMessage, listChatBotMembers, resolveUserUnionId, getChatModeStrict, getMessageThreadId, uploadFile, UserTokenMissingError } from '../im/lark/client.js';
import { chatAppLink, threadAppLink, normalizeBrand } from '../im/lark/lark-hosts.js';
import { claimPairing } from '../services/pairing-store.js';
import { logger } from '../utils/logger.js';
import { scheduleTimeZone } from '../utils/timezone.js';
import { killWorker, teardownAuthoritativePersistentBackingBeforeClose, suspendWorker, forkWorker, forkAdoptWorker, adoptSandboxBlocked, getCurrentCliVersion, postFreshStreamingCard, postPrivateSnapshotCard, resolvePrivateCardAudience, deliverEphemeralOrReply, deliverWritableTerminalCardTo, closeSession as closeWorkerPoolSession, withActiveSessionKeyLock, requestSessionRestart, isSessionTransferring, type WorkerSessionReplyOptions } from './worker-pool.js';
import {
  expandHome,
  getSessionWorkingDir,
  getProjectScanDir,
  getProjectScanDirs,
  rememberLastCliInput,
  buildNewTopicCliInput,
  ensureSessionWhiteboard,
  getAvailableBots,
} from './session-manager.js';
import { markInitialUserTurnPending } from './initial-user-turn.js';
import { discoverSlashCommandsForAdapter, listMcpServerNames, supportsFilesystemCommandDiscovery } from './command-discovery.js';
import { validateWorkingDir } from './working-dir.js';
import { repinSessionWorkingDir } from './session-cwd.js';
import { validateAdoptTarget, adoptTargetKey, adoptTargetLabel, type AdoptableSession } from './session-discovery.js';
import { validateZellijAdoptTarget, type ZellijAdoptableSession } from './zellij-adopt-discovery.js';
import { listCodexAppThreads, type CodexAppThreadSummary } from '../services/codex-app-threads.js';
import { generateAuthUrl, getTokenStatus, resolveUserToken, DOC_COMMENT_OAUTH_SCOPES, FEED_GROUP_OAUTH_SCOPES } from '../utils/user-token.js';
import { DocSubscriptionPermissionError, listDocComments, resolveDocFile, subscribeDocFile, unsubscribeDocFile } from '../im/lark/doc-comment.js';
import { parseDocWatchCommand } from './doc-watch-command.js';
import { parseVcMeetingPrepareCommand } from './vc-meeting-prepare-command.js';
import { latestDocCommentPollCursor } from './doc-comment-poller.js';
import {
  putDocSubscription, removeDocSubscription, listDocSubscriptionsForSession, listAllDocSubscriptions, getDocSubscription,
  type CommentTriggerMode, type DocSubscription,
} from '../services/doc-subs-store.js';
import {
  findVcMeetingPreparationByChat,
  getVcMeetingPreparation,
  listVcMeetingPreparations,
  putVcMeetingPreparation,
  removeVcMeetingPreparation,
  removeVcMeetingPreparationsByChat,
} from '../services/vc-meeting-preparations-store.js';
import { bindOncall, unbindOncall, getOncallStatus } from '../services/oncall-store.js';
import {
  CONFIG_FIELDS, findConfigField, settableFieldKeys, parseBooleanValue,
  applyConfigField, setBotAllowedUsers, getConfigSnapshot, getConfigCardData, coerceConfigValue, type ConfigEffect,
} from '../services/bot-config-store.js';
import { resolveCliId, findInvalidAllowedUserEntries } from '../setup/bot-config-editor.js';
import { buildClosedSessionCard } from './closed-session-card.js';
import { ttadkConfigModelChoices } from '../setup/cli-selection.js';
import { publishAttentionPatch, announcePendingRepoSession } from './session-activity.js';
import { setCardMode } from '../services/card-mode-store.js';
import { canOperate } from '../im/lark/event-dispatcher.js';
import { buildSafeInsightReport } from '../services/insight/report.js';
import type { SafeInsightReport } from '../services/insight/types.js';
import { invalidWorkingDirs } from '../utils/working-dir.js';
import { writeRoleFile, deleteRoleFile, resolveRole, resolveRoleFile, resolveTeamRoleFile, writeTeamRoleFile, deleteTeamRoleFile, MAX_ROLE_BYTES } from './role-resolver.js';
import { getBotCapability, setBotCapability, clearBotCapability } from '../services/bot-profile-store.js';
import {
  deleteRoleProfileEntry,
  deleteRoleProfileIfEmpty,
  isValidRoleProfileId,
  listRoleProfileEntries,
  listRoleProfiles,
  MAX_ROLE_PROFILE_ENTRY_BYTES,
  readRoleProfileEntry,
  writeRoleProfileEntry,
} from '../services/role-profile-store.js';
import type { LarkMessage, DaemonToWorker, CodexAppTurnInput, FrozenSessionReplyTarget } from '../types.js';
import type { ResolvedSender } from '../im/lark/identity-cache.js';
import { activeSessionKey, sessionKey, sessionAnchorId, markRepoCardConsumed, claimCurrentRepoCard } from './types.js';
import type { DaemonSession } from './types.js';
import { t, localeForBot, type Locale } from '../i18n/index.js';
import { runSkillsImCommand } from './skills/im-command.js';
import { fetchDaemonIpc } from './daemon-ipc-auth.js';
import { updateSessionTitle } from './session-title.js';
import { requestAgentSessionRename } from './session-rename.js';
import { hasProtectedSessionMutationOwnership } from './session-mutation-guard.js';
import { withBotTurnMutation } from './bot-turn-mutation-gate.js';
import {
  configuredRuntimeDisplayName,
  sessionConfiguredRuntimeDisplayName,
} from './cli-runtime-display.js';
import { isSessionGroup } from '../services/session-groups-store.js';

// ─── Exported constants ──────────────────────────────────────────────────────

// DAEMON_COMMANDS / PASSTHROUGH_COMMANDS / normalizePassthroughCommand now live
// in the leaf ./passthrough-commands.js so the config store can share the
// normalization without a circular import; imported for internal use and
// re-exported to keep callers (daemon.ts, tests) importing from command-handler
// unchanged.
import { DAEMON_COMMANDS, PASSTHROUGH_COMMANDS, normalizePassthroughCommand, parseCustomPassthroughInput } from './passthrough-commands.js';
export { DAEMON_COMMANDS, PASSTHROUGH_COMMANDS };

/**
 * Daemon commands that act on the chat itself rather than opening a
 * conversation. `/group` (`/g`) just creates a Lark group and replies once —
 * no follow-up turns, no CLI worker. The new-topic spawn path normally
 * pre-creates a sessionStore record so a command can attach state and keep
 * card buttons routable, but for these that record is a phantom conversation
 * that pollutes the dashboard's session list. Handle them without a session.
 */
export const SESSIONLESS_DAEMON_COMMANDS = new Set<string>();

const SLASH_GROUP_NAME_MAX_UTF16_LENGTH = 50;

/** Apply the machine-wide prefix used only by `/group` and `/g`, then keep the
 *  existing Lark headroom. The legacy limit is measured in UTF-16 code units;
 *  iterating by code point keeps that limit without slicing an emoji's
 *  surrogate pair. */
export function formatSlashGroupName(name: string, prefix = ''): string {
  const prefixed = prefix && !name.startsWith(prefix) ? `${prefix}${name}` : name;
  if (prefixed.length <= SLASH_GROUP_NAME_MAX_UTF16_LENGTH) return prefixed;

  let truncated = '';
  for (const character of prefixed) {
    if (truncated.length + character.length > SLASH_GROUP_NAME_MAX_UTF16_LENGTH) break;
    truncated += character;
  }
  return `${truncated}…`;
}

/**
 * Daemon commands that operate on an ALREADY-EXISTING session and must never
 * pre-create one. With no real session to operate on, the daemon routes must skip their generic
 * "createSession + activeSessions.set(worker:null)" pre-create block and let
 * handleCommand's `!ds` branch reply no_active_session. Without this, one of these commands
 * in a brand-new topic (or a thread with no session) would spawn a phantom
 * worker:null session just to handle it, polluting the dashboard. (Same class
 * of fix as the `/card` / `/term` special cases in daemon.ts.)
 */
export const EXISTING_SESSION_ONLY_DAEMON_COMMANDS = new Set<string>();

/**
 * Adapter-scoped default passthrough commands (e.g. Codex's `/goal`).
 *
 * `cliIdOverride` lets a caller resolve against a session's FROZEN CLI instead
 * of the bot's current config — an existing session keeps the runtime it was
 * created with, so changing `/botconfig cli` must not silently strip an old
 * interactive Codex session's adapter-scoped `/goal` (nor grant one to a Codex
 * App session). `defaultPassthroughCommands` is a static per-adapter list and
 * does not depend on the resolved binary, so when the override diverges from
 * the bot's current CLI we intentionally drop `cliPathOverride` (it belongs to
 * the other CLI) and let the adapter resolve with no path hint.
 */
export function resolveAdapterDefaultPassthroughCommands(larkAppId?: string, cliIdOverride?: string): string[] {
  if (!larkAppId) return [];
  try {
    const bot = getBot(larkAppId);
    const cliId = (cliIdOverride ?? bot.config.cliId) as CliId;
    const cliPathOverride = cliId === bot.config.cliId ? bot.config.cliPathOverride : undefined;
    const adapter = createCliAdapterSync(cliId, cliPathOverride);
    const normalized = (adapter.defaultPassthroughCommands ?? [])
      .map(normalizePassthroughCommand)
      .filter((c): c is string => !!c);
    return [...new Set(normalized)];
  } catch {
    return [];
  }
}

/**
 * Effective passthrough set for a bot: the fixed {@link PASSTHROUGH_COMMANDS}
 * plus adapter-scoped defaults and the bot's `customPassthroughCommands`
 * (bots.json). Entries that would shadow a botmux daemon command are dropped —
 * daemon commands must keep their daemon semantics, and passthrough is checked
 * BEFORE DAEMON_COMMANDS in the router, so an un-filtered custom `/status`
 * would hijack the daemon's own.
 * Codex App deliberately resolves to an empty set because its runner speaks
 * App Server rather than an interactive TUI; slash-looking text must use the
 * structured turn lane. Unknown / no bot → falls back to the builtin set.
 */
/** Runner adapters speak a framed stdin protocol, not an interactive TUI:
 * raw slash passthrough would bypass the turn ledger and the runner rejects
 * non-frame input. Both the routing and the /list-slash-command display must
 * agree on this set. */
const NO_RAW_PASSTHROUGH_CLI_IDS = new Set(['codex-app', 'mira', 'mir', 'dsh']);

export function cliHasNoRawPassthroughSurface(cliId: string | undefined): boolean {
  return !!cliId && NO_RAW_PASSTHROUGH_CLI_IDS.has(cliId);
}
export function resolvePassthroughCommands(_larkAppId?: string, _cliIdOverride?: string): Set<string> {
  return new Set();
}
// ─── Helpers ─────────────────────────────────────────────────────────────────

export interface SlashCommandInvocation {
  cmd: string;
  content: string;
}

const MULTILINE_COMMANDS = new Set(['/schedule']);

// `validateWorkingDir` now lives in ./working-dir.js (leaf module the CLI can
// import without the daemon graph); re-exported here for existing callers.
export { validateWorkingDir };

/**
 * Resolve a non-numeric `/repo <arg>` into a concrete repo path + display name.
 * `arg` is either a path (absolute or relative) or a first-level project name
 * under one of the bot's scan dirs — letting the user skip the selection card.
 *
 * Resolution:
 *   1. Build candidate absolute paths — absolute / `~` taken as-is; relative or
 *      bare names resolved against each scan dir, then the daemon cwd (mirrors
 *      how the card's project list is rooted).
 *   2. Return the first directly existing candidate, describing its git ref
 *      without scanning unrelated roots. This is lenient like `/cd`, whose trust
 *      model is "owner explicitly chose a dir"; the CLI already runs with full
 *      FS access.
 *   3. Only for a bare name that did not directly resolve, scan projects and
 *      match by basename (covers projects nested deeper than the scan-dir top
 *      level).
 * Returns null when nothing resolves to an existing directory.
 */
export function resolveRepoSelection(
  repoArg: string,
  scanDirs: string[],
): { path: string; displayName: string } | null {
  const isExplicitPath =
    repoArg.startsWith('/') ||
    repoArg.startsWith('~') ||
    repoArg.startsWith('.') ||
    repoArg.includes('/');

  const candidates: string[] = [];
  if (repoArg.startsWith('/') || repoArg.startsWith('~')) {
    candidates.push(resolve(expandHome(repoArg)));
  } else {
    for (const d of scanDirs) candidates.push(resolve(d, repoArg));
    candidates.push(resolve(expandHome(repoArg))); // daemon-cwd fallback (matches /cd)
  }

  // Direct candidates must win before any recursive scan. Besides avoiding
  // unnecessary traversal (especially a legacy HOME fallback), describing just
  // the selected directory preserves the same "name (branch)" label for repos.
  for (const cand of candidates) {
    try {
      if (!statSync(cand).isDirectory()) continue;
    } catch {
      continue; // missing / not a dir — try next candidate
    }
    const desc = describeProjectDir(cand);
    return desc
      ? { path: cand, displayName: `${desc.name} (${desc.branch})` }
      : { path: cand, displayName: basename(cand) };
  }

  // Explicit and relative paths have no basename-search semantics: when their
  // concrete candidates do not exist, a recursive project scan cannot resolve
  // them. Bare names alone may refer to a repo nested below a scan root.
  if (isExplicitPath) return null;

  const existingScanDirs = scanDirs.filter((d) => existsSync(d));
  const projects = existingScanDirs.length > 0 ? scanMultipleProjects(existingScanDirs) : [];
  const byName = projects.find((p) => p.name === repoArg);
  if (byName) return { path: byName.path, displayName: `${byName.name} (${byName.branch})` };

  return null;
}

/**
 * Parse a force-topic invocation: `/t [prompt]` or `/topic [prompt]`.
 *
 * This is a routing meta-command, distinct from `parseSlashCommandInvocation`
 * (which routes to daemon command handlers). The match conditions are
 * deliberately tighter than the regular slash parser:
 *
 * - exact-prefix match (`/t` / `/topic`, case-insensitive); `/tea` / `/topical`
 *   must NOT match, otherwise we'd false-trigger on common /-prefixed words.
 * - tolerates leading whitespace (mention-stripping can leave a space).
 * - prompt is whatever follows the prefix (verbatim, including newlines).
 * - `/t` alone (no args) is allowed → empty prompt; the daemon treats it as
 *   topic setup, choosing either a repository picker or a visible thread that
 *   waits for the first real task according to the bot's cwd configuration.
 *
 * Returns null for anything else, so callers can fall through to the regular
 * `parseSlashCommandInvocation` / message-handling path.
 */
export function parseForceTopicInvocation(content: string): { prompt: string } | null {
  const trimmed = content.replace(/^\s+/, '');
  const match = /^\/(t|topic)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return null;
  return { prompt: (match[2] ?? '').trim() };
}

/** Parse a user-authored slash command after leading @mentions have already
 *  been stripped. Messages that look like command examples or command lists
 *  are intentionally left for the CLI instead of being intercepted by the
 *  daemon; otherwise discussion text such as `/adopt <pane>` can accidentally
 *  trigger real daemon actions. */
export function parseSlashCommandInvocation(content: string): SlashCommandInvocation | null {
  // trim BOTH ends: a trailing newline/space rides into the returned `content`
  // and, for a passthrough command relayed verbatim to the CLI (raw_input), gets
  // typed as a literal trailing newline — which breaks the CLI's slash-command
  // detection (it sees a multi-line message, not a `/cmd`). Internal newlines for
  // MULTILINE_COMMANDS are preserved (trim only touches the ends).
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) return null;

  const lines = trimmed.split(/\r?\n/);
  const firstLine = (lines[0] ?? '').trimEnd();
  const [cmdRaw] = firstLine.split(/\s+/);
  const cmd = cmdRaw?.toLowerCase();
  if (!cmd) return null;

  // Treat angle-bracket placeholders as documentation, not an invocation.
  if (/<[^>\r\n]+>/.test(firstLine)) return null;

  const restNonBlank = lines.slice(1).map(l => l.trim()).filter(Boolean);
  if (restNonBlank.length > 0) {
    // A list of slash commands is almost certainly discussion / planning text.
    if (restNonBlank.some(l => l.startsWith('/'))) return null;
    if (!MULTILINE_COMMANDS.has(cmd)) return null;
  }

  return { cmd, content: trimmed };
}

function tag(ds: DaemonSession): string {
  return ds.session.sessionId.substring(0, 8);
}

/**
 * Lowercased display names of ALL bots known to the deployment, read from the
 * shared bots-info.json. This is the only globally-complete, process-stable
 * source of "is this @-mention a bot?": production runs one daemon per bot, so
 * getAllBots() only sees this process's own bot, and the live chat-member roster
 * (listChatBotMembers) can transiently miss a bot — either would let competing
 * bot processes disagree on who the first @-mentioned bot is and double-create.
 * bots-info.json is a local file merge-written by every daemon at startup.
 */
function globalKnownBotNames(): Set<string> {
  try {
    const p = join(config.session.dataDir, 'bots-info.json');
    if (!existsSync(p)) return new Set();
    const entries: Array<{ botName?: string | null }> = JSON.parse(readFileSync(p, 'utf-8'));
    return new Set(entries.map(e => e.botName?.toLowerCase()).filter((n): n is string => !!n));
  } catch {
    return new Set();
  }
}

/** Human-friendly name for a bot larkAppId — Lark app display name, else cliId, else the raw id. */
function botDisplayName(larkAppId: string): string {
  try {
    const bot = getBot(larkAppId);
    return bot.botName ?? getCliDisplayName(bot.config.cliId) ?? larkAppId;
  } catch {
    return larkAppId;
  }
}

function sessionCliDisplayName(ds: DaemonSession): string {
  const botCfg = getBot(ds.larkAppId).config;
  const configured = sessionConfiguredRuntimeDisplayName(ds.session, botCfg.cliRuntime);
  if (configured) return configured;
  return getCliDisplayName(ds.session.cliId ?? botCfg.cliId);
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function codexAppThreadTitle(thread: CodexAppThreadSummary): string {
  const raw = (thread.name || thread.preview || thread.threadId).replace(/\s+/g, ' ').trim();
  return raw.length > 80 ? raw.slice(0, 79) + '…' : raw;
}

function invalidConfiguredWorkingDirs(ds: DaemonSession | undefined, larkAppId: string | undefined): string[] {
  if (ds?.workingDir) return invalidWorkingDirs({ workingDir: ds.workingDir });
  if (larkAppId) {
    const bot = getBot(larkAppId);
    return invalidWorkingDirs({
      workingDir: bot.config.workingDir ?? '~',
      workingDirs: bot.config.workingDirs,
    });
  }
  return invalidWorkingDirs({
    workingDir: config.daemon.workingDir ?? '~',
    workingDirs: config.daemon.workingDirs,
  });
}


// ─── Types ───────────────────────────────────────────────────────────────────

export interface CommandHandlerDeps {
  activeSessions: Map<string, DaemonSession>;
  sessionReply: (rootId: string, content: string, msgType?: string, larkAppId?: string, turnId?: string, opts?: WorkerSessionReplyOptions) => Promise<string>;
  getActiveCount: () => number;
  lastRepoScan: Map<string, import('../services/project-scanner.js').ProjectInfo[]>;
  /** Immutable Lark placement captured by the daemon for this slash-command
   * invocation. Unlike session state, it remains valid after close/replace. */
  invocationReplyTarget?: FrozenSessionReplyTarget;
  /** 会前预热文档评论会话：立即启动 CLI、读取文档并进入待命。 */
  prewarmDocCommentSession?: (ds: DaemonSession, sub: DocSubscription) => Promise<void>;
}

// ─── Main command handler ──────────────────────────────────────────────────
export async function handleCommand(
  cmd: string,
  rootId: string,
  message: LarkMessage,
  deps: CommandHandlerDeps,
  larkAppId?: string,
): Promise<void> {
  const { activeSessions, getActiveCount, lastRepoScan } = deps;
  // Command replies carry the triggering messageId as the turnId so a shared
  // (chat-scope) session triggered from inside a Lark thread anchors them into
  // that thread (resolveSessionReplyTarget turnId gate) instead of leaking a
  // plain top-level message.
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId, message.messageId);
  const ds = larkAppId ? activeSessions.get(sessionKey(rootId, larkAppId)) : undefined;
  const logTag = ds ? tag(ds) : rootId.substring(0, 12);
  const loc: Locale = localeForBot(ds?.larkAppId ?? larkAppId);

  logger.info(`[${logTag}] Command: ${cmd}`);
  logger.debug(`repo command`, message);

  try {
    switch (cmd) {
      case '/restart': {
        if (ds) {
          if (ds.adoptedFrom) {
            await sessionReply(rootId, t('card.action.adopt_no_restart', undefined, loc));
            break;
          }
          if (isRiffBackendSession(ds)) {
            logger.info(`[${logTag}] Rejected /restart for Riff backend session`);
            await sessionReply(rootId, t('cmd.restart.riff_unsupported', undefined, loc));
            break;
          }
          // Codex App: an accepted-but-unsettled dispatch still owns the turn
          // route. requestSessionRestart does not itself gate on dispatch
          // ownership, so reject here before the coordinator tears the worker
          // down (mirrors the card-handler restart path).
          if (hasProtectedSessionMutationOwnership(ds)) {
            await sessionReply(
              rootId,
              '当前 Codex App 仍有未结算消息，暂不能重启；请等待本轮完成或关闭会话。',
            );
            break;
          }
          if (isSessionTransferring(ds)) {
            await sessionReply(rootId, t('cmd.session.transfer_in_progress', undefined, loc));
            break;
          }
          const cliName = sessionCliDisplayName(ds);
          requestSessionRestart(ds, {
            source: 'slash',
            notify: async status => {
              await sessionReply(rootId, t(`cmd.restart.${status}`, { cliName }, loc));
            },
          });
          logger.info(`[${logTag}] Restart by /restart command`);
        } else {
          await sessionReply(rootId, t('cmd.no_active_session', undefined, loc));
        }
        break;
      }

      case '/help': {
        await sessionReply(rootId, [
          '```',
          t('help.model_list', undefined, loc),
          t('help.model_set', undefined, loc),
          t('help.effort_list', undefined, loc),
          t('help.effort_set', undefined, loc),
          t('help.new', undefined, loc),
          t('help.restart', { cliName: ds ? sessionCliDisplayName(ds) : 'CLI' }, loc),
          '```',
        ].join('\n'));
        break;
      }
    }
  } catch (err: any) {
    logger.error(`[${logTag}] Command ${cmd} error: ${err.message}`);
  }
}

function isZellijTarget(t: AdoptableSession | ZellijAdoptableSession): t is ZellijAdoptableSession {
  return 'zellijPaneId' in t;
}

/**
 * Refuse a takeover (`/adopt`, Codex App thread, disk resume import) while the
 * session is still on the first-spawn repo-select gate (`pendingRepo`).
 *
 * Adopt/import attaches to an already-running CLI, so it cannot double as a way
 * to finish that gate — the two states are mutually exclusive by design. Rather
 * than migrate the pending placeholder in place (which used to leave a
 * contradictory `adopt` + "待选仓库" session, and risked folding botmux
 * envelopes into the external CLI), we post a card that explains the refusal
 * and offers a one-tap "close session". After the user closes it, a fresh
 * `/adopt` runs as a clean first message (which never enters pendingRepo).
 *
 * Returns true when the takeover was blocked (caller must return immediately).
 * Note pendingRepo is in-memory only, so this can never wrongly fire on a
 * daemon-restored session.
 */
async function blockTakeoverWhilePendingRepo(
  ds: DaemonSession,
  sessionReply: (rid: string, content: string, msgType?: string) => Promise<string>,
): Promise<boolean> {
  if (!ds.pendingRepo) return false;
  const loc = localeForBot(ds.larkAppId);
  const card = buildAdoptBlockedCard(
    sessionAnchorId(ds),
    ds.session.sessionId,
    getBot(ds.larkAppId).config.cliId,
    loc,
  );
  await sessionReply(sessionAnchorId(ds), card, 'interactive');
  logger.info(`[${tag(ds)}] Takeover refused: session still on pendingRepo gate — posted close-session card`);
  return true;
}

/**
 * A live Riff worker cannot be replaced through the generic adopt/import
 * refork path: that path sends a request-less close and then kills the local
 * worker, while Riff requires its remote task to finish the explicit
 * prepare/commit close protocol first. Refuse before target validation or any
 * persisted ownership mutation so the original lineage stays recoverable.
 */
async function blockRiffTakeover(
  ds: DaemonSession,
  sessionReply: (rid: string, content: string, msgType?: string) => Promise<string>,
): Promise<boolean> {
  if (!isRiffBackendSession(ds)) return false;
  const loc = localeForBot(ds.larkAppId);
  await sessionReply(sessionAnchorId(ds), t('cmd.takeover.riff_unsupported', undefined, loc));
  logger.warn(`[${tag(ds)}] Takeover refused: Riff session requires explicit close before replacement`);
  return true;
}


export async function startCodexAppThreadSession(
  thread: CodexAppThreadSummary,
  ds: DaemonSession,
  deps: CommandHandlerDeps,
  larkAppId?: string,
): Promise<void> {
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId);
  const loc: Locale = localeForBot(ds.larkAppId ?? larkAppId);
  const title = codexAppThreadTitle(thread);
  if (isSessionTransferring(ds)) {
    await sessionReply(sessionAnchorId(ds), t('cmd.session.transfer_in_progress', undefined, loc));
    return;
  }

  if (await blockRiffTakeover(ds, sessionReply)) return;
  if (await blockTakeoverWhilePendingRepo(ds, sessionReply)) return;

  const targetSessionId = ds.session.sessionId;
  const switched = await withBotTurnMutation(ds.larkAppId, async () => {
    const current = [...deps.activeSessions.values()].find(
      candidate => candidate.session.sessionId === targetSessionId
        && candidate.session.status === 'active',
    );
    if (!current || current !== ds) return { status: 'gone' as const };
    if (hasProtectedSessionMutationOwnership(current)) {
      return { status: 'pending' as const, anchor: sessionAnchorId(current) };
    }
    current.adoptedFrom = undefined;
    current.workingDir = thread.cwd;
    current.hasHistory = true;
    current.currentTurnTitle = undefined;
    current.lastScreenContent = undefined;
    current.lastScreenStatus = undefined;
    current.session.workingDir = thread.cwd;
    current.session.title = `Codex App: ${title}`;
    current.session.cliId = 'codex-app';
    current.session.cliSessionId = thread.threadId;
    current.session.adoptedFrom = undefined;
    sessionStore.updateSession(current.session);
    forkWorker(current, '', true);
    return { status: 'switched' as const, anchor: sessionAnchorId(current) };
  });
  if (switched.status === 'gone') {
    await sessionReply(sessionAnchorId(ds), t('cmd.no_active_session', undefined, loc));
    return;
  }
  if (switched.status === 'pending') {
    await sessionReply(
      switched.anchor,
      '当前 Codex App 仍有未结算消息，不能切换原生 thread；请等待本轮完成或先关闭会话。',
    );
    return;
  }
  await sessionReply(switched.anchor, t('cmd.codex_app_adopt.success', { title }, loc));
}

export async function startAdoptSession(
  target: AdoptableSession | ZellijAdoptableSession,
  ds: DaemonSession,
  deps: CommandHandlerDeps,
  larkAppId?: string,
): Promise<void> {
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId);
  const loc: Locale = localeForBot(ds.larkAppId ?? larkAppId);
  if (isSessionTransferring(ds)) {
    await sessionReply(sessionAnchorId(ds), t('cmd.session.transfer_in_progress', undefined, loc));
    return;
  }

  if (await blockRiffTakeover(ds, sessionReply)) return;

  const zellij = isZellijTarget(target);
  if (!zellij && target.source === 'herdr' && target.herdrSessionName && target.herdrAgentName) {
    const occupied = [...deps.activeSessions.values()].some(active => {
      if (active.session.sessionId === ds.session.sessionId || active.session.status !== 'active' || active.adoptedFrom) return false;
      const owned = active.session.persistentBackendTarget;
      return owned?.backendType === 'herdr'
        && owned.sessionName === target.herdrSessionName
        && owned.agentName === target.herdrAgentName;
    });
    if (occupied) {
      await sessionReply(sessionAnchorId(ds), t('cmd.adopt.target_exited', undefined, loc));
      return;
    }
  }

  // Fail-closed at the ENTRY point, BEFORE any target validation or state
  // mutation: a sandbox-enabled bot can't wrap an already-running CLI
  // (confinement is spawn-time only). Reject here so `adoptedFrom` is never
  // persisted and "adopted" is never replied — otherwise the session would
  // become a worker=null pseudo-adopt whose next message still routes as a
  // bridge/adopt session. Covers both real host-process adopt entries
  // (`/adopt <pane>` and the adopt_select card, which both route here). Checks
  // the live bot flag AND the session's frozen sandbox decision (union).
  const adoptBotCfg = getBot(ds.larkAppId ?? larkAppId).config;
  const adoptRuntimeExecutable = ds.session.agentFrozen
    ? ds.session.cliRuntime?.source === 'configured' ? ds.session.cliRuntime.executable : undefined
    : adoptBotCfg.cliRuntime?.executable;
  if (adoptSandboxBlocked(adoptBotCfg, ds.session)) {
    await sessionReply(sessionAnchorId(ds), t('cmd.adopt.sandbox_blocked', undefined, loc));
    return;
  }

  // A session still on the repo-select gate can't be adopted in place — refuse
  // and offer a one-tap close so the user retires it and re-adopts cleanly.
  if (await blockTakeoverWhilePendingRepo(ds, sessionReply)) return;

  const valid = zellij
    ? validateZellijAdoptTarget(
      target.zellijSession,
      target.zellijPaneId,
      target.cliPid,
      target.cliId,
      adoptRuntimeExecutable,
    )
    : validateAdoptTarget(target, adoptRuntimeExecutable);
  if (!valid) {
    await sessionReply(sessionAnchorId(ds), t('cmd.adopt.target_exited', undefined, loc));
    return;
  }

  const project = target.cwd.split('/').pop() || target.cwd;
  const pane = zellij ? `${target.zellijSession}/${target.zellijPaneId}` : adoptTargetLabel(target);
  const targetSessionId = ds.session.sessionId;
  const adopted = await withBotTurnMutation(ds.larkAppId, async () => {
    const current = [...deps.activeSessions.values()].find(
      candidate => candidate.session.sessionId === targetSessionId
        && candidate.session.status === 'active',
    );
    if (!current || current !== ds) return { status: 'gone' as const };
    if (hasProtectedSessionMutationOwnership(current)) {
      return { status: 'pending' as const, anchor: sessionAnchorId(current) };
    }
    current.workingDir = target.cwd;
    current.session.workingDir = target.cwd;
    current.session.title = `Adopt: ${project}`;
    current.adoptedFrom = {
      source: zellij ? 'zellij' : target.source,
      tmuxTarget: zellij ? undefined : target.tmuxTarget,
      zellijSession: zellij ? target.zellijSession : undefined,
      zellijPaneId: zellij ? target.zellijPaneId : undefined,
      herdrSessionName: zellij ? undefined : target.herdrSessionName,
      herdrTarget: zellij ? undefined : target.herdrTarget,
      herdrPaneId: zellij ? undefined : target.herdrPaneId,
      herdrAgentName: zellij ? undefined : target.herdrAgentName,
      herdrTerminalId: zellij ? undefined : target.herdrTerminalId,
      originalCliPid: target.cliPid,
      sessionId: target.sessionId,
      cliId: target.cliId,
      cwd: target.cwd,
      paneCols: target.paneCols,
      paneRows: target.paneRows,
    };
    current.session.adoptedFrom = { ...current.adoptedFrom };
    sessionStore.updateSession(current.session);
    forkAdoptWorker(current);
    return { status: 'adopted' as const, anchor: sessionAnchorId(current) };
  });
  if (adopted.status === 'gone') {
    await sessionReply(sessionAnchorId(ds), t('cmd.no_active_session', undefined, loc));
    return;
  }
  if (adopted.status === 'pending') {
    await sessionReply(
      adopted.anchor,
      '当前 Codex App 仍有未结算消息，不能切换到外部会话；请等待本轮完成或先关闭会话。',
    );
    return;
  }

  const cliName = sessionCliDisplayName(ds);
  await sessionReply(sessionAnchorId(ds), t('cmd.adopt.success', { cliName, project, pane }, loc));
}

/** Cap on resume candidates surfaced by the /adopt picker. Kept at the legacy
 *  20 (per product call: the V2 card is a display change, not a scope change).
 *  When the cap is hit the card shows a hint pointing at search + the
 *  `/adopt <id>` direct path, so history beyond the cap is still reachable. */
export const ADOPT_RESUME_LIMIT = 20;

/** Discover the sessions resumable from disk for `cliId`, excluding any whose
 *  CLI-native id is already live in a botmux session (so a session botmux
 *  already runs isn't offered for re-import). Returns [] when the adapter has
 *  no on-disk store. */
export async function discoverResumableSessionsForBot(
  cliId: CliId,
  cliPathOverride: string | undefined,
  activeSessions: Map<string, DaemonSession>,
  limit = ADOPT_RESUME_LIMIT,
): Promise<ResumableSession[]> {
  let adapter: ReturnType<typeof createCliAdapterSync>;
  try { adapter = createCliAdapterSync(cliId, cliPathOverride); } catch { return []; }
  if (!adapter.listResumableSessions) return [];
  // Exclude every session botmux already manages — live OR closed — so the
  // picker surfaces only genuinely external sessions (a CLI the user ran
  // standalone). botmux's own closed sessions stay resumable via their
  // session-closed cards, so hiding them here avoids a redundant, confusing
  // duplicate. The identity set spans all bot stores and includes both the
  // botmux sessionId (= the claude jsonl filename) and the cliSessionId
  // (codex/traex rollout id), covering every CLI's id shape. Passed INTO the
  // adapter so exclusion happens BEFORE the `limit` truncation.
  const exclude = sessionStore.collectBotmuxSessionIdentities() ?? new Set<string>();
  // Belt-and-suspenders: also fold in the in-memory active map (freshest).
  for (const ds of activeSessions.values()) {
    if (ds.session.sessionId) exclude.add(ds.session.sessionId);
    if (ds.session.cliSessionId) exclude.add(ds.session.cliSessionId);
  }
  try {
    return await adapter.listResumableSessions({ limit, exclude });
  } catch {
    return [];
  }
}

/** Import (resume) a stored session into the current topic: re-spawn the bot's
 *  CLI via `--resume <cliSessionId>` in `cwd`. Mirrors the manual resume path —
 *  the worker owns the CLI (NOT an observe-adopt), so no `adoptedFrom` is set. */
export async function startResumeImportSession(
  target: ResumableSession,
  ds: DaemonSession,
  deps: CommandHandlerDeps,
  larkAppId?: string,
): Promise<void> {
  const sessionReply = (rid: string, content: string, msgType?: string) =>
    deps.sessionReply(rid, content, msgType, larkAppId);
  const loc: Locale = localeForBot(ds.larkAppId ?? larkAppId);
  const project = target.cwd.split('/').pop() || target.cwd;
  if (isSessionTransferring(ds)) {
    await sessionReply(sessionAnchorId(ds), t('cmd.session.transfer_in_progress', undefined, loc));
    return;
  }

  if (await blockRiffTakeover(ds, sessionReply)) return;
  if (await blockTakeoverWhilePendingRepo(ds, sessionReply)) return;

  const targetSessionId = ds.session.sessionId;
  const resumed = await withBotTurnMutation(ds.larkAppId, async () => {
    const current = [...deps.activeSessions.values()].find(
      candidate => candidate.session.sessionId === targetSessionId
        && candidate.session.status === 'active',
    );
    if (!current || current !== ds) return { status: 'gone' as const };
    if (hasProtectedSessionMutationOwnership(current)) {
      return { status: 'pending' as const, anchor: sessionAnchorId(current) };
    }
    current.workingDir = target.cwd;
    current.session.workingDir = target.cwd;
    current.session.cliSessionId = target.cliSessionId;
    current.session.title = target.title || `Import: ${project}`;
    // Resume sandbox decision is left to forkWorker (resume=true → not
    // sandboxed, matching restore semantics). Mark history so this is a resume.
    current.hasHistory = true;
    sessionStore.updateSession(current.session);
    forkWorker(current, '', true);
    return { status: 'resumed' as const, anchor: sessionAnchorId(current) };
  });
  if (resumed.status === 'gone') {
    await sessionReply(sessionAnchorId(ds), t('cmd.no_active_session', undefined, loc));
    return;
  }
  if (resumed.status === 'pending') {
    await sessionReply(
      resumed.anchor,
      '当前 Codex App 仍有未结算消息，不能导入外部会话；请等待本轮完成或先关闭会话。',
    );
    return;
  }

  const cliName = sessionCliDisplayName(ds);
  await sessionReply(sessionAnchorId(ds), t('cmd.adopt.resume_success', { cliName, project, title: target.title || target.cliSessionId.slice(0, 8) }, loc));
}

type ForkSubtopicResult =
  | { ok: true; childSessionId: string; anchorId: string; link: string }
  | { ok: false; error: string; orphanTopic: boolean };

/** Fork the current session into a new sub-topic of the same topic group.
 *  The session copy itself stays in worker-pool's generic `forkSession()`;
 *  this layer only creates the Lark destination, supplies the first task turn,
 *  and records display-only lineage for the parent panel. */
export async function startForkSubtopicSession(
  taskText: string,
  parentDs: DaemonSession,
  message: LarkMessage,
  larkAppId?: string,
): Promise<ForkSubtopicResult> {
  const appId = parentDs.larkAppId ?? larkAppId;
  if (!appId) return { ok: false, error: 'missing_lark_app_id', orphanTopic: false };

  const loc: Locale = localeForBot(appId);
  const bot = getBot(appId);
  const botCfg = bot.config;
  const parentSession = parentDs.session;
  const chatId = parentDs.chatId;
  const brand = normalizeBrand(botCfg.brand);
  const taskTitle = taskText.split(/\r?\n/).map(line => line.trim()).find(Boolean)?.slice(0, 60)
    ?? taskText.slice(0, 60);
  const senderIsBot = message.senderType === 'app' || message.senderType === 'bot';
  const triggerSender: ResolvedSender = {
    openId: message.senderId,
    type: senderIsBot ? 'bot' : 'user',
    ...(message.senderName ? { name: message.senderName } : {}),
  };
  let anchorId: string | undefined;

  const recallAnchor = async (): Promise<boolean> => {
    if (!anchorId) return true;
    try {
      return await deleteMessage(appId, anchorId);
    } catch (err) {
      logger.warn(
        `[${parentSession.sessionId.substring(0, 8)}] /fork sub-topic recall failed: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  try {
    let parentThreadId = parentSession.larkThreadId ?? message.threadId;
    if (!parentThreadId) {
      parentThreadId = (await getMessageThreadId(appId, parentSession.rootMessageId)) ?? undefined;
    }
    if (parentThreadId && parentSession.larkThreadId !== parentThreadId) {
      parentSession.larkThreadId = parentThreadId;
      sessionStore.updateSession(parentSession);
    }
    const parentLink = parentThreadId
      ? threadAppLink(chatId, parentThreadId, brand)
      : chatAppLink(chatId, brand);

    const localeKey = loc === 'en' ? 'en_us' : 'zh_cn';
    const seedPost = JSON.stringify({
      [localeKey]: {
        title: `${t('cmd.fork.badge', undefined, loc)} ${taskText.replace(/\s*\n+\s*/g, ' ').slice(0, 300)}`,
        content: [[
          ...(senderIsBot ? [] : [{ tag: 'at', user_id: message.senderId }]),
          {
            tag: 'text',
            text: `${senderIsBot ? '' : ' '}${t('cmd.fork.seed_parent_line', { title: parentSession.title || '' }, loc)} `,
          },
          { tag: 'a', text: t('cmd.fork.seed_back_link', undefined, loc), href: parentLink },
        ]],
      },
    });
    anchorId = await sendMessage(appId, chatId, seedPost, 'post');
    const childThreadId = (await getMessageThreadId(appId, anchorId)) ?? undefined;

    const childIntro = t('cmd.fork.child_intro', {
      parentTitle: parentSession.title || '',
      parentSessionId: parentSession.sessionId,
      parentRootId: parentSession.rootMessageId,
    }, loc);
    const availableBots = await getAvailableBots(appId, chatId);
    const childCliId = parentSession.cliId ?? botCfg.cliId;
    const { forkSession } = await import('./worker-pool.js');
    const forkResult = await forkSession(
      parentSession.sessionId,
      chatId,
      anchorId,
      'group',
      'thread',
      {
        childTitle: `${t('cmd.fork.badge', undefined, loc)} ${taskTitle}`,
        forkTaskText: taskText,
        larkThreadId: childThreadId,
        turnId: message.messageId,
        senderOpenId: triggerSender.openId,
        senderIsBot,
        buildInitialPrompt: childSessionId => buildNewTopicCliInput(
          `${childIntro}\n\n${taskText}`,
          childSessionId,
          childCliId,
          botCfg.cliPathOverride,
          undefined,
          undefined,
          availableBots,
          undefined,
          { name: bot.botName, openId: bot.botOpenId },
          loc,
          triggerSender,
          { larkAppId: appId, chatId },
        ),
      },
    );

    if (!forkResult.ok) {
      const orphanTopic = !await recallAnchor();
      return { ok: false, error: forkResult.error, orphanTopic };
    }

    if (!parentSession.forkChildSessionIds?.includes(forkResult.childSessionId)) {
      parentSession.forkChildSessionIds = [
        ...(parentSession.forkChildSessionIds ?? []),
        forkResult.childSessionId,
      ];
      try {
        sessionStore.updateSession(parentSession);
      } catch (err) {
        logger.warn(
          `[${parentSession.sessionId.substring(0, 8)}] /fork parent lineage update failed: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    try {
      await upsertForkPanelCard(parentDs, loc);
    } catch (err) {
      logger.warn(
        `[${parentSession.sessionId.substring(0, 8)}] /fork panel refresh failed: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      ok: true,
      childSessionId: forkResult.childSessionId,
      anchorId,
      link: childThreadId ? threadAppLink(chatId, childThreadId, brand) : chatAppLink(chatId, brand),
    };
  } catch (err) {
    logger.error(
      `[${parentSession.sessionId.substring(0, 8)}] /fork sub-topic failed: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      ok: false,
      error: anchorId ? 'fork_subtopic_failed' : 'topic_creation_failed',
      orphanTopic: anchorId ? !await recallAnchor() : false,
    };
  }
}

/** Re-post the parent session's fork panel at the bottom of the topic. Reading
 *  each child row from the store keeps `/forklist` status current without
 *  coupling child lifecycle to its parent. */
async function upsertForkPanelCard(
  parentDs: DaemonSession,
  loc: Locale,
  opts?: { allowEmpty?: boolean; preferredReplyToMessageId?: string },
): Promise<void> {
  const appId = parentDs.larkAppId;
  const chatId = parentDs.chatId;
  const brand = normalizeBrand(getBot(appId).config.brand);
  const children = (parentDs.session.forkChildSessionIds ?? [])
    .map(sessionId => sessionStore.getSession(sessionId))
    .filter((session): session is NonNullable<ReturnType<typeof sessionStore.getSession>> => !!session)
    .map(session => ({
      instruction: session.forkTaskText ?? session.title,
      status: (session.status === 'active' ? 'active' : 'closed') as 'active' | 'closed',
      // Link to the child's OWN chat: a sub-topic fork shares the parent chat and
      // carries a larkThreadId (deep-link into that topic); a --create fork lives
      // in its own new group (different chatId, no thread) so the link must use
      // the child's chatId, not the parent's, or it would point back here.
      link: session.larkThreadId
        ? threadAppLink(session.chatId ?? chatId, session.larkThreadId, brand)
        : chatAppLink(session.chatId ?? chatId, brand),
    }));
  if (children.length === 0 && !opts?.allowEmpty) return;

  const staleCardId = parentDs.session.forkPanelCardId;
  if (staleCardId) {
    try {
      await deleteMessage(appId, staleCardId);
    } catch {
      // It may already be withdrawn or past Lark's recall window. Posting the
      // fresh panel is still more useful than keeping the command silent.
    }
  }

  // Post the panel. Primary: reply-in-thread to the session's root message so
  // the panel anchors to this conversation. Fallback: if that reply fails (the
  // most common cause is the root message aging past Lark's reply window —
  // surfaces as HTTP 400 — but also covers a withdrawn root), post the card flat
  // to the chat instead. The panel IS the user-visible output of /forklist, so a
  // swallowed failure looks like the command silently did nothing; the flat send
  // keeps it visible. Only if BOTH transports fail do we give up (and warn).
  const cardBody = buildForkPanelCard(children, loc);
  // Reply targets are tried in order, then a flat send as the last resort:
  //   1) the FRESH triggering command message (when /forklist or /fork passes
  //      it) — a just-arrived message is never past Lark's reply window, and in
  //      a 话题群 it keeps the panel inside the current topic;
  //   2) the session root message — the historical target, but it can age past
  //      the reply window (HTTP 400) or be withdrawn;
  //   3) a flat chat sendMessage — always delivers, though in a 话题群 it starts
  //      a new sibling topic rather than threading. The panel is the user-visible
  //      output of /forklist, so a visible-but-flat panel beats silent nothing.
  const replyTargets: string[] = [];
  if (opts?.preferredReplyToMessageId) replyTargets.push(opts.preferredReplyToMessageId);
  if (parentDs.session.rootMessageId
    && parentDs.session.rootMessageId !== opts?.preferredReplyToMessageId) {
    replyTargets.push(parentDs.session.rootMessageId);
  }
  let cardId: string | undefined;
  for (const target of replyTargets) {
    try {
      cardId = await replyMessage(appId, target, cardBody, 'interactive', true);
      break;
    } catch (replyErr) {
      logger.warn(
        `[fork-panel] reply to ${target} failed `
        + `(${replyErr instanceof Error ? replyErr.message : replyErr})`,
      );
    }
  }
  if (!cardId) {
    logger.warn('[fork-panel] all reply targets failed; falling back to a flat chat message');
    try {
      cardId = await sendMessage(appId, chatId, cardBody, 'interactive');
    } catch (sendErr) {
      logger.warn(
        `[fork-panel] failed to post panel card via both reply and flat send: `
        + `${sendErr instanceof Error ? sendErr.message : sendErr}`,
      );
    }
  }
  if (cardId) {
    // Local guard: a write-store failure here must not bubble to /forklist's
    // outer catch (which would look like the command errored even though the
    // panel already posted). Losing only the stale-card id just means the next
    // /forklist can't delete the previous panel — a benign duplicate at worst.
    parentDs.session.forkPanelCardId = cardId;
    try {
      sessionStore.updateSession(parentDs.session);
    } catch (err) {
      logger.warn(
        `[fork-panel] persist forkPanelCardId failed: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
