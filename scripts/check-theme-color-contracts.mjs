#!/usr/bin/env node
/**
 * Prevent dark-theme accent combinations from leaking into theme-aware UI.
 *
 * Bright primary text such as text-primary-100/200 is readable on Tower's dark
 * surfaces but can disappear on light or translucent surfaces. Stateful UI must
 * use the semantic tone classes, which bind foreground, background, and border
 * for both supported themes.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'packages/frontend/src/components/files/ProjectHome.tsx'),
  path.join(ROOT, 'packages/frontend/src/components/agents/AgentHomeOverview.tsx'),
  path.join(ROOT, 'packages/frontend/src/components/agents/AITeamHome.tsx'),
  path.join(ROOT, 'packages/frontend/src/components/chat/ChatPanel.tsx'),
  path.join(ROOT, 'packages/frontend/src/components/layout/Sidebar.tsx'),
  path.join(ROOT, 'packages/frontend/src/components/layout/EngineSwitchConfirmModal.tsx'),
  path.join(ROOT, 'packages/frontend/src/components/layout/FileTabBar.tsx'),
  path.join(ROOT, 'packages/frontend/src/components/beta/BetaPanel.tsx'),
  path.join(ROOT, 'packages/frontend/src/components/beta/AgentHiringWizard.tsx'),
  path.join(ROOT, 'packages/frontend/src/components/agents/AgentsPanel.tsx'),
  path.join(ROOT, 'packages/frontend/src/components/files/HtmlPreviewSurface.tsx'),
  path.join(ROOT, 'packages/frontend/src/components/files/MarkdownTtsControls.tsx'),
  path.join(ROOT, 'packages/frontend/src/components/files/FilesWorkspace.tsx'),
  path.join(ROOT, 'packages/frontend/src/components/admin/AdminPanel.tsx'),
];

const forbidden = [
  {
    re: /\b(?:bg-primary-[^\s"'`}]+\s+[^\n"'`}]*text-primary-(?:50|100|200)|text-primary-(?:50|100|200)\s+[^\n"'`}]*bg-primary-[^\s"'`}]+)/g,
    message: 'Use tone-accent with tone-action/tone-pill/tone-card instead of assembling a translucent primary background with bright primary text.',
  },
  {
    re: /\b(?:bg-surface-(?:700|800)[^\s"'`}]*\s+[^\n"'`}]*text-(?:white|primary-(?:50|100|200))|text-(?:white|primary-(?:50|100|200))\s+[^\n"'`}]*bg-surface-(?:700|800)[^\s"'`}]*?)/g,
    message: 'Selected surface states must use a semantic theme pair instead of dark-only foreground colors.',
  },
];

const violations = [];
for (const file of TARGETS) {
  const text = await fs.readFile(file, 'utf8');
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const sourceLine = lines[index];
    // Keep hover/focus/selected variants in scope: they are user-visible light
    // theme states and previously escaped this guard entirely.
    const lightThemeSegment = sourceLine.split(/\bdark:/u, 1)[0];
    for (const [ruleIndex, rule] of forbidden.entries()) {
      // The selected-surface rule intentionally covers persistent selected
      // states; generic hover:text-white remains a separate future cleanup.
      const inspectedSegment = ruleIndex === 1
        ? lightThemeSegment.replace(/(?:^|\s)(?:[\w[\]-]+:)*hover:[^\s"'`}]+/gu, ' ')
        : lightThemeSegment;
      rule.re.lastIndex = 0;
      if (rule.re.test(inspectedSegment)) {
        violations.push({
          file: path.relative(ROOT, file),
          line: index + 1,
          text: sourceLine.trim(),
          message: rule.message,
        });
        break;
      }
    }
  }
}

if (violations.length > 0) {
  console.error('❌ Theme color contract violations detected:\n');
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}`);
    console.error(`    ${violation.text}`);
    console.error(`    → ${violation.message}\n`);
  }
  process.exit(1);
}

console.log(`✓ Theme color contracts clean (${TARGETS.length} guarded surfaces)`);
