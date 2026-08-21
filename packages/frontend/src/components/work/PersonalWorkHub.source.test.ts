import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const hub = fs.readFileSync(path.resolve(import.meta.dirname, './PersonalWorkHub.tsx'), 'utf8');
const timeline = fs.readFileSync(path.resolve(import.meta.dirname, './ChallengeTimelinePanel.tsx'), 'utf8');

describe('Legacy personal hub extraction', () => {
  it('presents todos as a localized note-like part of personal materials', () => {
    expect(hub).toContain("useTranslation('layout')");
    expect(hub).toContain("t('personalWorkHub.title')");
    expect(hub).toContain("t('personalWorkHub.description')");
    expect(hub).toContain("t('personalWorkHub.checklist')");
    expect(hub).toContain("t('personalWorkHub.newNote')");
    expect(hub).toContain('i18n.resolvedLanguage || i18n.language');
    expect(hub).toContain('/api/personal-space/todos');
    expect(hub).toContain('/api/personal-space/files');
    expect(hub).not.toContain('승인·결재');
    expect(hub).not.toContain('pendingAssignedCount');
  });

  it('keeps personal materials out of the actual Workstream surface', () => {
    expect(timeline).toContain("tr('challenge.timeline.title')");
    expect(timeline).toContain('<WorkstreamList embedded={embedded} projects={data.projects} selectedWorkstreamKey={selectedWorkstreamKey}');
    expect(timeline).toContain('<WorkstreamOverview challenge={selectedChallenge} onBack={returnToActivity} />');
    expect(timeline).not.toContain('<PersonalWorkHub');
    expect(timeline).not.toContain('<ApprovalInbox />');
    expect(timeline).not.toContain('<FileExchangeSurface');
  });

  it('loads personal files and todos independently with a retryable partial state', () => {
    expect(hub).toContain("readPersonalJson('/api/personal-space/files')");
    expect(hub).toContain("readPersonalJson('/api/personal-space/todos')");
    expect(hub).toContain('setItemsLoading(false)');
    expect(hub).toContain('setTodosLoading(false)');
    expect(hub).toContain('setItemsFailed(true)');
    expect(hub).toContain('setTodosFailed(true)');
    expect(hub).toContain("t('personalWorkHub.partialLoadFailed')");
    expect(hub).toContain('setLoadAttempt((attempt) => attempt + 1)');
  });

});
