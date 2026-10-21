import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './Header.tsx'), 'utf8');
const tabDefinitions = source.slice(source.indexOf('const tabs = React.useMemo'), source.indexOf('// Determine active key'));
const agentFirstStart = tabDefinitions.indexOf('if (agentFirstEnabled)');
const agentFirstReturn = tabDefinitions.indexOf('return [', agentFirstStart);
const agentFirstNav = tabDefinitions.slice(agentFirstStart, tabDefinitions.indexOf('];', agentFirstReturn) + 2);

describe('Agent-first top information architecture', () => {
  it('keeps Conversations and Files without duplicate Work or retired Channel tabs', () => {
    expect(source).toContain('if (agentFirstEnabled)');
    expect(agentFirstNav).toContain("label: t('conversationsNav')");
    expect(agentFirstNav).not.toContain("{ key: 'work'");
    expect(agentFirstNav).not.toContain("key: 'channel'");
    expect(agentFirstNav).toContain("{ key: 'files', label: t('files'), badge: 0 }");
    expect(agentFirstNav).not.toContain('if (pgEnabled)');
    expect(agentFirstNav).not.toContain("key: 'schedule'");
    expect(agentFirstNav).not.toContain("key: 'ai-services'");
  });

  it('groups personal surfaces and operations in the hamburger menu', () => {
    for (const key of ['mySpace', 'operations', 'settingsAndManagement']) expect(source).toContain(`<MenuSection label={t('${key}')} />`);
    expect(source).not.toContain("label={t('myTodo')}");
    expect(source).not.toContain('openTodoCount');
    expect(source).not.toContain("label={isMobile ? t('myDocuments') : t('myMaterials')}");
    expect(source).not.toContain('onClick={onPersonalMaterialsClick}');
    expect(source).toContain("label={t('workHistory')}");
    expect(source).toContain("description={t('workHistoryDescription')}");
    expect(source).toContain("label={t('pendingReplies')}");
    expect(source).toContain("description={t('pendingRepliesDescription')}");
    expect(source).toContain('onClick={onInboxClick}');
    expect(source).not.toContain("label={t('favorites')}");
    expect(source).not.toContain('testId="global-nav-favorites"');
    expect(source).not.toContain("label={t('sessionHistory')}");
    expect(source).toContain("store.setActiveView('work')");
    expect(source).toContain("label={t('automation')}");
    expect(source).toContain("description={t('automationDescription')}");
    expect(source).toContain("store.setActiveView('schedules')");
    expect(source).toContain("label={t('externalAgentDeployment')}");
    expect(source).toContain("store.setActiveView('aiServices')");
    expect(source).not.toContain('betaWorkbenchEnabled');
    expect(source).not.toContain("label={t('skillWorkbench')}");
    expect(source).not.toContain("detail: { mode: 'skill-workbench' }");
    expect(source).not.toContain('BetaFeatureMenu');
    expect(source).not.toContain('CAD Workbench');
    expect(source).not.toContain('cadWorkbenchBetaEnabled');
    expect(source).not.toContain('label={t(\'newProject\')}');
    expect(source).not.toContain('label="새 에이전트"');
    expect(source).toContain("description={t('publishingHubDescription')}");
    expect(source).toContain("description={t('skillsMarketDescription')}");
  });

  it('renders optional descriptions as secondary menu copy without relying on hover', () => {
    expect(source).toContain('description?: string');
    expect(source).toContain('{description && <span');
    expect(source).toContain('text-[12px] leading-4 text-surface-500');
    expect(source).toContain('w-72 max-h-[calc(100dvh-4.5rem)]');
  });

  it('removes Channel from the legacy navigation too', () => {
    const legacyNav = tabDefinitions.slice(tabDefinitions.lastIndexOf('return ['));
    expect(legacyNav).not.toContain("key: 'channel'");
    expect(legacyNav).toContain("{ key: 'files', label: t('files'), badge: 0 }");
    expect(legacyNav).not.toContain('if (pgEnabled)');
    expect(legacyNav).not.toContain("key: 'schedule'");
  });
});
