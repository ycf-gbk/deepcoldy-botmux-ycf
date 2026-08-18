import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { prepareSkillDelivery } from '../src/core/skills/delivery.js';
import { sharedSkillsDir } from '../src/core/skills/registry-paths.js';
import type { SessionSkillManifest } from '../src/core/skills/types.js';

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('Claude scoped skill delivery', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'botmux-skill-plugin-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('Claude uses the same shared prompt delivery as every other backend', () => {
    const adapter = createCliAdapterSync('claude-code');
    const args = adapter.buildArgs({ sessionId: 's1', resume: false, skillPluginDir: '/tmp/session-plugin' });
    const pluginDirs = args.flatMap((arg, index) => arg === '--plugin-dir' ? [args[index + 1]] : []);

    expect(pluginDirs).toEqual([]);
  });

  it('delivers the shared root through the common prompt path', () => {
    write(join(root, 'deploy', 'SKILL.md'), '# Deploy');
    const manifest: SessionSkillManifest = {
      sessionId: 's1',
      cliId: 'codex',
      workingDir: '/repo',
      policyMode: 'priority',
      prioritySkills: [{
        id: 'deploy',
        name: 'deploy',
        tags: [],
        rootDir: join(root, 'deploy'),
        entrypoint: 'SKILL.md',
        source: { type: 'user', root: join(root, 'deploy') },
        priorityReason: 'bot:include',
      }],
      diagnostics: [],
      generatedAt: '2026-06-14T00:00:00.000Z',
    };

    const prepared = prepareSkillDelivery(createCliAdapterSync('codex'), manifest, 'native');

    expect(prepared.fatal).toBeUndefined();
    expect(prepared.prompt).toBe(true);
    expect(prepared.readonlyRoots).toContain(sharedSkillsDir());
  });
});
