import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, './ProjectHome.tsx'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/en/files.json'), 'utf8'));
const ko = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/ko/files.json'), 'utf8'));

const keys = [
  'notesLoadFailedStatus', 'notesLoadFailed', 'teammateUpdateFailed', 'teammateSaved',
  'characterGenerateFailed', 'noProjectTitle', 'noProjectDescription', 'navigationLabel',
  'homeTab', 'allFilesTab', 'graphTab', 'copyToWorkspace', 'allWork', 'backHome',
  'completedWork', 'workedOn', 'done', 'needsAttention', 'inProgress', 'stepsNotRecorded',
  'openSession', 'noLinkedSessions', 'editTeammate', 'close', 'name', 'role', 'tagline',
  'skillsForTeammate', 'disabledSkillHint', 'skillsEnabledCount', 'useSkill',
  'noConfigurableSkills', 'selectProfile', 'selectDefaultProfile', 'profileSelectionLabel',
  'noDesiredProfile', 'generateProfileDescription', 'collapse', 'generateNewProfile',
  'currentSelectedProfile', 'imageConnectionHint', 'newProfileDescription',
  'profilePromptExample', 'generating', 'cancel', 'saving', 'save', 'instructionsTitle',
  'instructionsLoading', 'noInstructions',
];

describe('ProjectHome locale contract', () => {
  it('localizes navigation, teammate settings, and project instructions', () => {
    expect(source).toContain("useTranslation('files')");
    expect(source).toContain("t('projectHome.navigationLabel')");
    expect(source).toContain("t('projectHome.editTeammate')");
    expect(source).toContain('agentCreation.characterLabels.');
    expect(source).toContain("t('projectHome.instructionsTitle')");
  });

  it('ships matching English and Korean Project Home labels', () => {
    for (const key of keys) {
      expect(en.projectHome[key], `missing English Project Home key: ${key}`).toBeTruthy();
      expect(ko.projectHome[key], `missing Korean Project Home key: ${key}`).toBeTruthy();
    }
  });
});
