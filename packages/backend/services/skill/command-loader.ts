import fs from 'fs';
import path from 'path';
import os from 'os';

export interface SlashCommand {
  name: string;
  description: string;
  fullContent: string;
  source: 'commands' | 'skills';
}

/**
 * Legacy filesystem slash-command scan.
 *
 * Primary callers should use skill-registry.getCommandsForUser(), which reads
 * Tower DB skills, project-local skill paths, and managed library skills first.
 * This loader remains only as a compatibility fallback for old
 * ~/.claude/commands and ~/.claude/skills installs during migration.
 */
export function loadCommands(): SlashCommand[] {
  const commands: SlashCommand[] = [];
  const claudeDir = path.join(os.homedir(), '.claude');

  // Legacy fallback: scan ~/.claude/commands/
  const commandsDir = path.join(claudeDir, 'commands');
  if (fs.existsSync(commandsDir)) {
    scanDirectory(commandsDir, 'commands', commands);
  }

  // Legacy fallback: scan ~/.claude/skills/*/SKILL.md
  const skillsDir = path.join(claudeDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    scanSkillsDirectory(skillsDir, commands);
  }

  return commands;
}

/** Legacy scan of ~/.claude/skills/ — each subdirectory with SKILL.md becomes a slash command. */
function scanSkillsDirectory(dir: string, commands: SlashCommand[]) {
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (!item.isDirectory()) continue;
      const skillFile = path.join(dir, item.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;

      const content = fs.readFileSync(skillFile, 'utf-8');
      const nameOverride = parseFrontmatterField(content, 'name');
      const description = parseFrontmatterField(content, 'description');
      const skillName = nameOverride || item.name;

      commands.push({
        name: `/${skillName}`,
        description: description || `Skill: ${skillName}`,
        fullContent: content,
        source: 'skills',
      });
    }
  } catch {}
}

/** Extract a frontmatter field — handles bare, quoted, literal (|), and folded (>) block scalars */
function parseFrontmatterField(content: string, field: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return '';
  const fm = fmMatch[1];

  // Block scalar — literal (|) or folded (>): grab all indented lines, return first
  const block = fm.match(new RegExp(`^${field}:\\s*[|>][^\n]*\n((?:[ \\t]+[^\n]*\n?)+)`, 'm'));
  if (block) {
    const firstLine = block[1].replace(/^[ \t]+/gm, '').trim().split('\n')[0];
    return firstLine;
  }

  // Single line — capture full line, then strip surrounding quotes if present
  // (avoids cutting off at embedded quotes, e.g. description: Use when "x" or "y")
  const single = fm.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  if (single) {
    const val = single[1].trim();
    if (val.startsWith('"') && val.endsWith('"')) return val.slice(1, -1);
    return val;
  }

  return '';
}

function scanDirectory(dir: string, source: 'commands' | 'skills', commands: SlashCommand[]) {
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.isFile() && item.name.endsWith('.md')) {
        const name = item.name.replace('.md', '');
        const content = fs.readFileSync(path.join(dir, item.name), 'utf-8');
        // Parse frontmatter for description
        let description = '';
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const descMatch = fmMatch[1].match(/description:\s*(.+)/);
          if (descMatch) description = descMatch[1].trim();
        }
        if (!description) {
          const firstLine = content.split('\n')[0].trim();
          description = firstLine.startsWith('#') ? firstLine.replace(/^#+\s*/, '') : firstLine.slice(0, 80);
        }
        commands.push({
          name: `/${name}`,
          description,
          fullContent: content,
          source,
        });
      } else if (item.isDirectory()) {
        scanDirectory(path.join(dir, item.name), source, commands);
      }
    }
  } catch {}
}
