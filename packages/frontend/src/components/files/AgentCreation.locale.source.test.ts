import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const preview = fs.readFileSync(path.resolve(import.meta.dirname, './AgentDraftPreview.tsx'), 'utf8');
const googleSetup = fs.readFileSync(path.resolve(import.meta.dirname, './AgentGoogleConnectionSetup.tsx'), 'utf8');
const teamHome = fs.readFileSync(path.resolve(import.meta.dirname, '../agents/AITeamHome.tsx'), 'utf8');
const enFiles = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/en/files.json'), 'utf8'));
const koFiles = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/ko/files.json'), 'utf8'));
const enLayout = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/en/layout.json'), 'utf8'));
const koLayout = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../locales/ko/layout.json'), 'utf8'));

const creationKeys = [
  'newAiTeammate', 'heading', 'description', 'name', 'expectedExpertise', 'chooseFace',
  'create', 'creating', 'recoveryCreated', 'reopenConversation', 'employeeFallback', 'characterLabel',
];
const googleKeys = ['title', 'description', 'none', 'organization', 'dedicated', 'loadFailed', 'grantFailed', 'oauthFailed', 'readinessFailed', 'setupRequired', 'httpsRequired', 'redirectMismatch', 'callbackLabel', 'adminSetupHint'];
const homeKeys = ['aiTeamHomeTitle', 'newAiTeammate', 'createAiTeammate', 'aiTeammateList', 'noAiTeammates'];

describe('AI teammate creation locale contract', () => {
  it('keeps creation and Google setup copy in both languages', () => {
    for (const key of creationKeys) {
      expect(enFiles.agentCreation[key], `missing English agent creation key: ${key}`).toBeTruthy();
      expect(koFiles.agentCreation[key], `missing Korean agent creation key: ${key}`).toBeTruthy();
    }
    for (const key of googleKeys) {
      expect(enFiles.agentCreation.google[key], `missing English Google setup key: ${key}`).toBeTruthy();
      expect(koFiles.agentCreation.google[key], `missing Korean Google setup key: ${key}`).toBeTruthy();
    }
    expect(Object.keys(enFiles.agentCreation.characterLabels)).toEqual(Object.keys(koFiles.agentCreation.characterLabels));
    for (const key of homeKeys) {
      expect(enLayout[key], `missing English AI Team key: ${key}`).toBeTruthy();
      expect(koLayout[key], `missing Korean AI Team key: ${key}`).toBeTruthy();
    }
  });

  it('routes the full creation path through locale namespaces', () => {
    expect(teamHome).toContain("useTranslation('layout')");
    expect(teamHome).toContain("t('newAiTeammate')");
    expect(preview).toContain("useTranslation('files')");
    expect(preview).toContain("t('agentCreation.heading')");
    expect(preview).toContain('agentCreation.characterLabels.');
    expect(googleSetup).toContain("useTranslation('files')");
    expect(googleSetup).toContain("t('agentCreation.google.title')");
    expect(googleSetup).toContain("i18n.t('agentCreation.google.loadFailed'");
  });
});
