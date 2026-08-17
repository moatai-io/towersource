import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { findProjectAgentDefinition, loadProjectAgentDefinitions, normalizeAgentDefinition, saveProjectAgentDefinition } from './agent-definitions.js';

describe('agent-definitions', () => {
  it('normalizes an agent definition', () => {
    expect(normalizeAgentDefinition({
      id: 'reviewer',
      displayName: '리뷰어',
      face: 'character:core-engineer',
      tagline: '회귀를 먼저 찾습니다',
      role: '독립 코드 리뷰어',
      instruction: '변경사항을 읽고 위험을 보고한다.',
      visibility: 'sidebar',
      engine: 'pi',
      modelPolicy: 'high',
      effort: 'high',
      permissions: { canEdit: false },
    }, '/tmp/reviewer.agent.yaml')).toMatchObject({
      id: 'reviewer',
      displayName: '리뷰어',
      face: 'character:core-engineer',
      tagline: '회귀를 먼저 찾습니다',
      role: '독립 코드 리뷰어',
      instruction: '변경사항을 읽고 위험을 보고한다.',
      visibility: 'sidebar',
      engine: 'pi',
      modelPolicy: 'high',
      effort: 'high',
      permissions: { canEdit: false },
    });
  });

  it('rejects unknown model policies instead of silently falling back', () => {
    expect(() => normalizeAgentDefinition({
      id: 'unsafe-reviewer',
      role: '리뷰어',
      instruction: '검토한다.',
      modelPolicy: 'ultra-plus',
    }, '/tmp/unsafe-reviewer.agent.yaml')).toThrow('unsupported modelPolicy ultra-plus');
  });

  it('saves project .tower/agents definitions as yaml', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-agent-save-'));
    const saved = saveProjectAgentDefinition(root, {
      id: 'researcher',
      face: '🔎',
      tagline: '근거를 찾아 연결합니다',
      role: '자료 조사자',
      instruction: '자료를 찾고 근거를 요약한다.',
      visibility: 'background',
      modelPolicy: 'extra-high',
    });

    expect(saved.sourcePath).toBe(path.join(root, '.tower', 'agents', 'researcher.agent.yaml'));
    expect(loadProjectAgentDefinitions(root)[0]).toMatchObject({ id: 'researcher', face: '🔎', tagline: '근거를 찾아 연결합니다', role: '자료 조사자', modelPolicy: 'extra-high' });
    expect(() => saveProjectAgentDefinition(root, {
      id: 'researcher',
      role: '중복',
      instruction: '중복',
    })).toThrow(/already exists/);
  });

  it('loads project .tower/agents definitions and finds by id or display name', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-agent-definitions-'));
    const dir = path.join(root, '.tower', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'reviewer.agent.yaml'), `id: reviewer\ndisplayName: 리뷰어\nrole: 독립 코드 리뷰어\ninstruction: 변경사항을 읽고 위험을 보고한다.\nvisibility: background\npermissions:\n  canEdit: false\n`);

    const definitions = loadProjectAgentDefinitions(root);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({ id: 'reviewer', displayName: '리뷰어', visibility: 'background' });
    expect(findProjectAgentDefinition(root, 'reviewer')?.id).toBe('reviewer');
    expect(findProjectAgentDefinition(root, '리뷰어')?.id).toBe('reviewer');
  });
});
