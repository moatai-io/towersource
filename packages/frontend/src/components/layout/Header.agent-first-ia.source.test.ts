import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './Header.tsx'), 'utf8');
const tabDefinitions = source.slice(source.indexOf('const tabs = React.useMemo'), source.indexOf('// Determine active key'));
const agentFirstStart = tabDefinitions.indexOf('if (agentFirstEnabled)');
const agentFirstReturn = tabDefinitions.indexOf('return [', agentFirstStart);
const agentFirstNav = tabDefinitions.slice(agentFirstStart, tabDefinitions.indexOf('];', agentFirstReturn) + 2);

describe('Agent-first top information architecture', () => {
  it('keeps AI Team and Files without the retired Channel workspace', () => {
    expect(source).toContain('if (agentFirstEnabled)');
    expect(agentFirstNav).toContain("label: t('aiTeam')");
    expect(agentFirstNav).not.toContain("key: 'channel'");
    expect(agentFirstNav).toContain("{ key: 'files', label: t('files') }");
    expect(agentFirstNav).not.toContain('if (pgEnabled)');
    expect(agentFirstNav).not.toContain("key: 'work'");
    expect(agentFirstNav).not.toContain("key: 'schedule'");
    expect(agentFirstNav).not.toContain("key: 'ai-services'");
  });

  it('groups personal surfaces and operations in the hamburger menu', () => {
    for (const key of ['mySpace', 'operations', 'beta', 'settingsAndManagement']) expect(source).toContain(`<MenuSection label={t('${key}')} />`);
    expect(source).toContain("label={t('myTodo')}");
    expect(source).toContain('badge={openTodoCount}');
    expect(source).toContain('onClick={onPersonalTodosClick}');
    expect(source).toContain("label={isMobile ? t('myDocuments') : t('myMaterials')}");
    expect(source).toContain('onClick={onPersonalMaterialsClick}');
    expect(source).toContain("label={t('workHistory')}");
    expect(source).toContain("label={t('pendingReplies')}");
    expect(source).toContain('onClick={onInboxClick}');
    expect(source).toContain("label={t('favorites')}");
    expect(source).toContain("label={t('sessionHistory')}");
    expect(source).toContain("store.setActiveView('work')");
    expect(source).toContain("label={t('automation')}");
    expect(source).toContain("store.setActiveView('schedules')");
    expect(source).toContain("label={t('externalAgentDeployment')}");
    expect(source).toContain("store.setActiveView('aiServices')");
    expect(source).toContain("label={t('skillWorkbench')}");
    expect(source).toContain("detail: { mode: 'skill-workbench' }");
    expect(source).not.toContain('BetaFeatureMenu');
    expect(source).not.toContain('CAD Workbench');
    expect(source).not.toContain('cadWorkbenchBetaEnabled');
    expect(source).not.toContain('label={t(\'newProject\')}');
    expect(source).not.toContain('label="새 에이전트"');
  });

  it('removes Channel from the legacy navigation too', () => {
    const legacyNav = tabDefinitions.slice(tabDefinitions.lastIndexOf('return ['));
    expect(legacyNav).not.toContain("key: 'channel'");
    expect(legacyNav).toContain("{ key: 'files', label: t('files') }");
    expect(legacyNav).not.toContain('if (pgEnabled)');
    expect(legacyNav).not.toContain("key: 'schedule'");
  });
});
