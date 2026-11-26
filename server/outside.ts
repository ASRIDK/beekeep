// The person's own Claude Code setup: which MCP servers and skills exist. Bees get
// only the ones they were given by name.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { hiveHome } from './paths.ts';

type Servers = Record<string, McpServerConfig>;

function userServers(): Servers {
  try {
    const file = process.env.BEEKEEP_MCP_FILE ?? join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
    return (JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Servers }).mcpServers ?? {};
  } catch {
    return {};
  }
}

/** Names and kinds only. The configurations can hold secrets and never leave the server. */
export function listMcp(): { name: string; type: string }[] {
  return Object.entries(userServers())
    .filter(([name]) => name !== 'hive' && /^[\w-]+$/.test(name))
    .map(([name, c]) => ({ name, type: 'command' in c ? 'program' : ((c as { type?: string }).type ?? 'http') }));
}

export function mcpFor(names: string[]): Servers {
  const all = userServers();
  return Object.fromEntries(names.filter((n) => n !== 'hive' && Object.hasOwn(all, n)).map((n) => [n, all[n]!]));
}

const skillsDir = () => join(homedir(), '.claude/skills');

export function listSkills(): { name: string; about: string }[] {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, 'SKILL.md')))
    .map((name) => {
      const head = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(dir, name, 'SKILL.md'), 'utf8'))?.[1] ?? '';
      const about = /(?:^|\n)description:\s*[>|]?-?\s*([\s\S]*?)(?=\n[\w-]+:|$)/.exec(head)?.[1] ?? '';
      return { name, about: about.replace(/\s+/g, ' ').replace(/^["']|["']$/g, '').trim().slice(0, 200) };
    });
}

/**
 * A folder holding just the chosen skills, loadable as a plugin. This way a bee
 * gets a skill without the person's hooks and other plugins.
 */
export function skillsPlugin(beeId: string, names: string[]): string | null {
  const known = new Set(listSkills().map((s) => s.name));
  const chosen = names.filter((n) => known.has(n));
  const dir = join(hiveHome(), 'skills', beeId);
  rmSync(dir, { recursive: true, force: true });
  if (chosen.length === 0) return null;
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'skills'));
  writeFileSync(
    join(dir, '.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'mine', version: '1.0.0', description: 'Skills chosen for this bee' }),
  );
  for (const n of chosen) symlinkSync(realpathSync(join(skillsDir(), n)), join(dir, 'skills', n));
  return dir;
}
