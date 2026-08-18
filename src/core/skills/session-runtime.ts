import type { CliId } from '../../adapters/cli/types.js';
import { readGlobalConfig } from '../../global-config.js';
import { readSkillRegistry } from '../../services/skill-registry-store.js';
import { readSkillPackRegistry } from '../../services/skill-pack-store.js';
import type { BotSkillPolicy, SessionSkillManifest, SkillPackage } from './types.js';
import { discoverProjectSkills, discoverSharedSkills } from './discovery.js';
import { ensureSharedSkills } from '../../skills/installer.js';
import { removeSessionSkillManifest, writeSessionSkillManifest } from './manifest-store.js';
import { renderSkillCatalogBlock } from './prompt.js';
import { resolveSessionSkillManifest } from './session-resolver.js';

export interface PreparedSessionSkillPrompt {
  prompt: string;
  manifest: SessionSkillManifest | null;
}

export function prepareSessionSkillPrompt(opts: {
  sessionId: string;
  cliId: CliId;
  workingDir: string;
  prompt: string;
  botPolicy: BotSkillPolicy | undefined;
  /** Per-bot override. `off` suppresses the session catalog entirely. */
  skillInjection?: 'global' | 'prompt' | 'off';
  pluginSkills?: SkillPackage[];
}): PreparedSessionSkillPrompt {
  ensureSharedSkills();
  const sharedSkills = discoverSharedSkills();
  // Claude-family sessions otherwise receive the complete shared botmux skill
  // catalog on every cold start. Respect an explicit per-bot `off` setting so
  // lightweight bots can keep only the routing system prompt and avoid
  // exhausting the model context before the user's first turn.
  if (opts.skillInjection === 'off') {
    removeSessionSkillManifest(opts.sessionId);
    return { prompt: opts.prompt, manifest: null };
  }
  const allPluginSkills = [...(opts.pluginSkills ?? []), ...sharedSkills];
  if (!opts.botPolicy && allPluginSkills.length === 0) {
    removeSessionSkillManifest(opts.sessionId);
    return { prompt: opts.prompt, manifest: null };
  }
  const globalSkills = readGlobalConfig().skills;
  const manifest = resolveSessionSkillManifest({
    sessionId: opts.sessionId,
    cliId: opts.cliId,
    workingDir: opts.workingDir,
    botPolicy: opts.botPolicy,
    pluginSkills: allPluginSkills,
    globalProjectSkills: globalSkills?.trustProjectSkills,
    globalDelivery: globalSkills?.delivery,
    registrySkills: Object.values(readSkillRegistry().skills),
    projectSkills: discoverProjectSkills(opts.workingDir),
    packs: readSkillPackRegistry().packs,
  });
  if (!manifest || manifest.prioritySkills.length === 0) {
    removeSessionSkillManifest(opts.sessionId);
    return { prompt: opts.prompt, manifest };
  }
  writeSessionSkillManifest(manifest);
  if (opts.prompt.trim().length === 0 || opts.prompt.includes('<botmux_skills')) {
    return { prompt: opts.prompt, manifest };
  }
  return {
    prompt: `${opts.prompt}\n\n${renderSkillCatalogBlock(manifest)}`,
    manifest,
  };
}
