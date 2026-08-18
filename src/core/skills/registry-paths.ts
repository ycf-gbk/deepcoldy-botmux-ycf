import { homedir } from 'node:os';
import { join } from 'node:path';

export function botmuxSkillsHome(): string {
  return join(homedir(), '.botmux', 'skills');
}

export function skillRegistryPath(): string {
  return join(botmuxSkillsHome(), 'registry.json');
}

export function skillPackRegistryPath(): string {
  return join(botmuxSkillsHome(), 'packs.json');
}

export function skillStoreDir(): string {
  return join(botmuxSkillsHome(), 'store');
}

/** Canonical runtime skill root shared by every bot and CLI backend. */
export function sharedSkillsDir(): string {
  return join(botmuxSkillsHome(), 'shared');
}

export function skillSourcesDir(): string {
  return join(botmuxSkillsHome(), 'sources');
}
