import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve('packages/frontend/src/components/skills/SkillsBrowserV2.tsx'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.resolve('packages/frontend/src/locales/en/skills.json'), 'utf8'));
const ko = JSON.parse(fs.readFileSync(path.resolve('packages/frontend/src/locales/ko/skills.json'), 'utf8'));

const keys = [
  'projectSkillsFallback', 'catalogLoadFailed', 'shareCompanyFailed', 'shareCompanyCreated',
  'shareCompanyExists', 'copyRequiresProject', 'copyProjectSkillFailed', 'defaultSkillBody',
  'createRequiresProject', 'createProjectSkillFailed', 'readyNow', 'needsSetup', 'shared',
  'backToSkillList', 'skillList', 'catalogResultSummary', 'catalogTotalSummary',
  'createSkillInCurrentProject', 'projectSkill', 'showAllTiers', 'teamTierOnly',
  'showHidden', 'hideHidden', 'dashboardLoading', 'registeredSkills', 'skillsAvailable',
  'createProjectSkill', 'newThisWeek', 'newLastWeekCount', 'popularWithTeammates',
  'activeInTeamThisWeek', 'browseByOrigin', 'originExplanation', 'viewFullCatalog',
  'catalogToolsHint', 'catalog', 'optional', 'defaultVisibleCount', 'noneYet', 'viewAllCount',
  'catalogSearchPlaceholder', 'selectProjectForSkills', 'noProjectSharedOnly', 'skillsLoading',
  'catalogUnavailable', 'catalogUnavailableHint', 'noMatchingSkills', 'reduceFiltersHint',
  'currentProjectReady', 'teammateSettingsHint', 'needsSetupHint', 'sort', 'sortRecentUsage',
  'sortName', 'currentSkillStructure', 'noProject', 'skillStructureDescription', 'projectOnly',
  'add', 'teamSharedSkills', 'teamskillsCatalog', 'filtering', 'connectionRuntimeReady',
  'retryLoad', 'recentUsage30Days', 'status', 'highRisk', 'available', 'originTower',
  'originTowerSubtitle', 'originCompany', 'originCompanySubtitle', 'originProject',
  'originProjectSubtitle', 'all', 'backToList', 'list', 'renderedView', 'sourceView',
  'fileLoading', 'binaryPreviewUnavailable', 'binaryMetadataOnly', 'noContentMarkdown',
  'binaryFile', 'noContent', 'shareWithCompany', 'createProjectCopy',
  'fileCount', 'fileCountWithFolders', 'metaType', 'metaVisibility', 'metaAccess', 'metaRisk',
  'connectionRequired', 'runtimeSetupRequired', 'checkRuntimeRequirements', 'private',
  'projectUse', 'close', 'skillNameFormat', 'skillNameValidation', 'descriptionHint',
  'descriptionExample', 'optionalField', 'contentDraft', 'contentDraftHint',
  'contentDraftPlaceholder', 'skillNameFallback', 'savedInCurrentProject',
  'availableFromNextRequest', 'additionalFilesHint', 'cancel', 'creating',
];

describe('SkillsBrowserV2 locale contract', () => {
  it('localizes loading, mutation feedback, filters, and header controls', () => {
    expect(source).toContain("useTranslation('skills')");
    expect(source).toContain("setLoadError(t('projectSkillsFallback'))");
    expect(source).toContain("toastError(err.error || t('shareCompanyFailed'))");
    expect(source).toContain("label: t('readyNow')");
    expect(source).toContain("t('catalogResultSummary'");
    expect(source).toContain("t('createSkillInCurrentProject')");
    expect(source).toContain("t('dashboardLoading')");
    expect(source).toContain("t('catalogSearchPlaceholder')");
    expect(source).toContain("t('currentSkillStructure')");
    expect(source).toContain("t(meta.labelKey)");
    expect(source).toContain("t('recentUsage30Days')");
    expect(source).toContain("t('renderedView')");
    expect(source).toContain("skillFileCountLabel(skill.files, t)");
    expect(source).toContain("t('shareWithCompany')");
    expect(source).toContain("t('skillNameValidation')");
    expect(source).toContain("t('savedInCurrentProject')");
  });

  it('ships matching English and Korean labels', () => {
    for (const key of keys) {
      expect(en[key], `missing English skill key: ${key}`).toBeTruthy();
      expect(ko[key], `missing Korean skill key: ${key}`).toBeTruthy();
    }
  });
});
