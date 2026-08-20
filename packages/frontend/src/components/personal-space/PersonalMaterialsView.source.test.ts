import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const view = fs.readFileSync(path.resolve(import.meta.dirname, './PersonalMaterialsView.tsx'), 'utf8');
const exchange = fs.readFileSync(path.resolve(import.meta.dirname, '../../features/file-exchange/FileExchangeSurface.tsx'), 'utf8');
const input = fs.readFileSync(path.resolve(import.meta.dirname, '../chat/InputBox.tsx'), 'utf8');
const context = fs.readFileSync(path.resolve(import.meta.dirname, '../layout/ContextPanel.tsx'), 'utf8');
const archive = fs.readFileSync(path.resolve(import.meta.dirname, './PersonalArchiveView.tsx'), 'utf8');
const app = fs.readFileSync(path.resolve(import.meta.dirname, '../../App.tsx'), 'utf8');
const api = fs.readFileSync(path.resolve(import.meta.dirname, '../../../../backend/routes/personal-space-api.ts'), 'utf8');
const store = fs.readFileSync(path.resolve(import.meta.dirname, '../../../../backend/services/personal-space/personal-space-store.ts'), 'utf8');

describe('Personal materials Viewer Pane', () => {
  it('shows owner-only files without duplicating the independent My Todo surface', () => {
    expect(view).toContain("t('myMaterials')");
    expect(view).toContain("t('personalMaterialsDescription')");
    expect(view).not.toContain('내 Todo');
    expect(view).not.toContain('내 체크리스트');
    expect(view).not.toContain('/api/personal-space/todos');
    expect(view).not.toContain("openPersonalPath('personal://todos')");
    expect(app).toContain("store.openTab('personal://todos'");
    expect(app).toContain("name: t('myTodo')");
    expect(context).toContain("openFile?.path === 'personal://todos'");
    expect(context).toContain('return <PersonalTodoView />');
    expect(view).toContain('<FileExchangeSurface personalOnly unifiedPersonal');
    expect(exchange).toContain("const systemRoots = new Set(['notes', 'files', 'archive'])");
    expect(exchange).toContain("readJson('/api/personal-space/files')");
    expect(exchange).toContain('/api/personal-space/files/upload');
    expect(exchange).toContain('/api/personal-space/files/create-directory');
    expect(exchange).toContain("t('fileExchange.changeNameLocation')");
    expect(exchange).toContain('onDrop={event =>');
  });

  it('lets a personal file be dragged into chat as a session attachment', () => {
    expect(exchange).toContain('FILE_EXCHANGE_DRAG_TYPE');
    expect(exchange).toContain('encodeExchangeDrag');
    expect(input).toContain("getData('application/x-tower-file-exchange')");
    expect(input).toContain("{ scope: 'session', sessionId }");
    expect(input).toContain('sessionAttachmentId: result.attachmentId');
    expect(exchange).toContain('useChatStore.getState().addAttachment');
    expect(exchange).toContain('sessionAttachmentId: result.attachmentId');
  });

  it('keeps the archive as a secondary state with restore support', () => {
    expect(view).toContain("openPersonalPath('personal://archive')");
    expect(view).toContain("t('personalArchive.title')");
    expect(context).toContain("openFile?.path === 'personal://archive'");
    expect(context).toContain('return <PersonalArchiveView />');
    expect(app).toContain("store.openTab('personal://archive'");
    expect(archive).toContain('/api/personal-space/files/archived');
    expect(archive).toContain('/restore');
    expect(api).toContain("router.get('/files/archived'");
    expect(api).toContain("router.post('/files/:id/restore'");
    expect(store).toContain('export async function restorePersonalFile');
  });

  it('opens as a dedicated right-side Viewer Pane tab', () => {
    expect(app).toContain("store.openTab('personal://materials'");
    expect(app).toContain("split: 'right'");
    expect(app).toContain('onPersonalMaterialsClick={openPersonalMaterialsInViewer}');
    expect(context).toContain("openFile?.path === 'personal://materials'");
    expect(context).toContain('return <PersonalMaterialsView />');
  });
});
