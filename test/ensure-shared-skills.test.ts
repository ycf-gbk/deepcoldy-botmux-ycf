import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureSharedSkills } from '../src/skills/installer.js';
import { sharedSkillsDir } from '../src/core/skills/registry-paths.js';

describe('shared skill installer', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'shared-skills-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    delete process.env.HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('installs the backend-independent built-in catalog into one root', () => {
    ensureSharedSkills();
    const root = sharedSkillsDir();
    expect(existsSync(join(root, 'botmux-send', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(root, 'botmux-send', 'SKILL.md'), 'utf8')).toContain('name: botmux-send');
  });
});
