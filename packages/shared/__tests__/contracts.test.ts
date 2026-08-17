import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Test 1B — Type contracts (field-level verification).
 * Ensures Base types contain API-boundary fields and exclude
 * backend-only or frontend-only fields.
 */

const SHARED_ROOT = path.resolve(import.meta.dirname, '..');

function readSource(file: string): string {
  return fs.readFileSync(path.join(SHARED_ROOT, file), 'utf-8');
}

describe('@tower/shared — type contracts', () => {
  it('SessionMeta에 engine 필드 존재', () => {
    const src = readSource('index.ts');
    // engine is in the base type because it's sent to frontend via API
    expect(src).toMatch(/engine\??\s*:/);
  });

  it('TaskMeta base에 roomId/triggeredBy/roomMessageId/userId/todoSnapshot 포함', () => {
    const src = readSource('index.ts');
    // Extract only the TaskMeta interface block
    const taskMetaMatch = src.match(/export interface TaskMeta\s*\{[\s\S]*?\n\}/);
    expect(taskMetaMatch).toBeTruthy();
    const taskMetaBlock = taskMetaMatch![0];
    expect(taskMetaBlock).toMatch(/\broomId\b/);
    expect(taskMetaBlock).toMatch(/\btriggeredBy\b/);
    expect(taskMetaBlock).toMatch(/\broomMessageId\b/);
    expect(taskMetaBlock).toMatch(/\buserId\b/);
    expect(taskMetaBlock).toMatch(/\btodoSnapshot\b/);
  });

  it('TodoItem 인터페이스 존재 (content + status)', () => {
    const src = readSource('index.ts');
    const todoItemMatch = src.match(/export interface TodoItem\s*\{[\s\S]*?\n\}/);
    expect(todoItemMatch).toBeTruthy();
    const block = todoItemMatch![0];
    expect(block).toMatch(/\bcontent\b/);
    expect(block).toMatch(/\bstatus\b/);
  });

  it('Project base에 userId 없음', () => {
    const src = readSource('index.ts');
    const projectMatch = src.match(/export interface Project\s*\{[\s\S]*?\n\}/);
    expect(projectMatch).toBeTruthy();
    const projectBlock = projectMatch![0];
    expect(projectBlock).not.toMatch(/\buserId\b/);
  });

  it('FileEntry base에 children/isExpanded/isLoading 없음', () => {
    const src = readSource('index.ts');
    const fileEntryMatch = src.match(/export interface FileEntry\s*\{[\s\S]*?\n\}/);
    expect(fileEntryMatch).toBeTruthy();
    const block = fileEntryMatch![0];
    expect(block).not.toMatch(/\bchildren\b/);
    expect(block).not.toMatch(/\bisExpanded\b/);
    expect(block).not.toMatch(/\bisLoading\b/);
  });

  it('Pin base에 pin_type/content/user_id 없음', () => {
    const src = readSource('index.ts');
    const pinMatch = src.match(/export interface Pin\s*\{[\s\S]*?\n\}/);
    expect(pinMatch).toBeTruthy();
    const block = pinMatch![0];
    expect(block).not.toMatch(/\bpin_type\b/);
    expect(block).not.toMatch(/\bcontent\b/);
    expect(block).not.toMatch(/\buser_id\b/);
  });
});
