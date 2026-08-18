import type { CliAdapter } from '../../adapters/cli/types.js';
import type { SessionSkillManifest } from './types.js';
import { sharedSkillsDir } from './registry-paths.js';

export interface PreparedSkillDelivery {
  prompt: boolean;
  pluginDir?: string;
  readonlyRoots: string[];
  diagnostics: string[];
  fatal?: boolean;
}

export function prepareSkillDelivery(
  _adapter: CliAdapter,
  manifest: SessionSkillManifest | null,
  _requested: 'auto' | 'prompt' | 'native',
): PreparedSkillDelivery {
  if (!manifest || manifest.prioritySkills.length === 0) {
    return { prompt: false, readonlyRoots: [], diagnostics: [] };
  }
  // All backends consume the same session catalog and read entries through
  // `botmux skill show/read`; no CLI-specific native directory or plugin is
  // created here. Keep the shared root readable inside restricted workers.
  return { prompt: true, readonlyRoots: [sharedSkillsDir()], diagnostics: [] };
}
