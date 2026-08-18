import { describe, expect, it, vi } from 'vitest';
import {
  DAEMON_COMMANDS,
  EXISTING_SESSION_ONLY_DAEMON_COMMANDS,
  SESSIONLESS_DAEMON_COMMANDS,
  handleCommand,
} from '../src/core/command-handler.js';
import { PUBLIC_COMMANDS } from '../src/core/passthrough-commands.js';

function deps() {
  return {
    activeSessions: new Map(),
    sessionReply: vi.fn(async () => 'message-id'),
    getActiveCount: () => 0,
    lastRepoScan: new Map(),
  };
}

describe('reduced public command surface', () => {
  it('exposes only the requested command roots', () => {
    expect([...PUBLIC_COMMANDS]).toEqual(['/model', '/effort', '/new', '/restart', '/help']);
    expect([...DAEMON_COMMANDS]).toEqual(['/restart', '/help']);
    expect(SESSIONLESS_DAEMON_COMMANDS.size).toBe(0);
    expect(EXISTING_SESSION_ONLY_DAEMON_COMMANDS.size).toBe(0);
  });

  it('renders only the requested usage lines in a code block', async () => {
    const d = deps();
    await handleCommand('/help', 'root', {
      content: '/help',
      messageId: 'message',
    } as any, d as any, 'app');

    const help = d.sessionReply.mock.calls[0]?.[1] as string;
    expect(help).toContain('```');
    expect(help).toContain('/model list');
    expect(help).toContain('/model <模型名>');
    expect(help).toContain('/effort list');
    expect(help).toContain('/effort <强度>');
    expect(help).toContain('/new');
    expect(help).toContain('/restart');
    for (const removed of ['/close', '/workflow', '/grant', '/relay', '/role', '/oncall', '/login']) {
      expect(help).not.toContain(removed);
    }
  });

  it('/restart stays direct and reports when no session exists', async () => {
    const d = deps();
    await handleCommand('/restart', 'root', {
      content: '/restart',
      messageId: 'message',
    } as any, d as any, 'app');
    expect(d.sessionReply).toHaveBeenCalledOnce();
  });
});
