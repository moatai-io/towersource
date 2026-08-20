import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = path.resolve(import.meta.dirname, '../..');
const app = fs.readFileSync(path.resolve(src, 'App.tsx'), 'utf8');
const header = fs.readFileSync(path.resolve(src, 'components/layout/Header.tsx'), 'utf8');
const mobile = fs.readFileSync(path.resolve(src, 'components/layout/MobileTabBar.tsx'), 'utf8');
const sidebar = fs.readFileSync(path.resolve(src, 'components/layout/Sidebar.tsx'), 'utf8');
const fileTabs = fs.readFileSync(path.resolve(src, 'components/layout/FileTabBar.tsx'), 'utf8');
const fileStore = fs.readFileSync(path.resolve(src, 'stores/file-store.ts'), 'utf8');
const chatRuntime = fs.readFileSync(path.resolve(src, 'hooks/useChatRuntime.ts'), 'utf8');
const reconnectSync = fs.readFileSync(path.resolve(src, 'utils/reconnect-sync.ts'), 'utf8');
const aiPanel = fs.readFileSync(path.resolve(src, 'components/rooms/AiPanel.tsx'), 'utf8');
const aiPanelStore = fs.readFileSync(path.resolve(src, 'stores/ai-panel-store.ts'), 'utf8');
const sessionStore = fs.readFileSync(path.resolve(src, 'stores/session-store.ts'), 'utf8');
const urlSync = fs.readFileSync(path.resolve(src, 'hooks/useUrlSync.ts'), 'utf8');
const notice = fs.readFileSync(path.resolve(import.meta.dirname, 'RetiredChannelNotice.tsx'), 'utf8');
const roomsLocale = (language: 'en' | 'ko') => JSON.parse(
  fs.readFileSync(path.resolve(src, `locales/${language}/rooms.json`), 'utf8'),
);
const fileExchange = fs.readFileSync(path.resolve(src, 'features/file-exchange/FileExchangeSurface.tsx'), 'utf8');
const publicAi = fs.readFileSync(path.resolve(src, 'features/ai-services/PublicAIServiceChat.tsx'), 'utf8');

describe('internal Channel P3 retirement surface', () => {
  it('removes Channel from desktop, mobile, and sidebar navigation', () => {
    expect(header).not.toContain("key: 'channel'");
    expect(mobile).not.toContain("id: 'channel'");
    expect(sidebar).not.toContain('<RoomList');
    expect(sidebar).not.toContain("sidebarTab === 'rooms'");
  });

  it('keeps old room links on a safe guidance screen instead of RoomPanel', () => {
    expect(app).toContain('<RetiredChannelNotice />');
    expect(app).not.toContain('<RoomPanel />');
    expect(app).not.toContain('findRoomByKey');
    expect(notice).toContain("t('retiredChannel.title')");
    expect(notice).toContain("t('retiredChannel.description')");
    expect(notice).toContain("setActiveView('work')");
    expect(roomsLocale('en').retiredChannel.title).toBe('Internal channels have been retired');
    expect(roomsLocale('ko').retiredChannel.title).toBe('내부 채널 기능이 종료되었습니다');
  });

  it('marks remaining rooms identifiers and URLs as legacy compatibility only', () => {
    expect(sessionStore).toContain('legacy compatibility identifier');
    expect(sessionStore).toContain('new product flows must not navigate to it');
    expect(urlSync).toContain('retired internal-channel link compatibility only');
    expect(urlSync).toContain('Resolves only to retirement guidance');
    expect(urlSync).toContain('Both forms resolve to `rooms` solely to render RetiredChannelNotice');
  });

  it('removes room tabs from persistence and the app shell', () => {
    expect(fileTabs).not.toContain('roomTabs');
    expect(fileTabs).not.toContain('activeRoomTabId');
    expect(fileStore).not.toContain('RoomTab');
    expect(fileStore).not.toContain('roomTabs');
    expect(fileStore).not.toContain('activeRoomTabId');
    expect(app).not.toContain('activeRoomTabId');
    expect(header).not.toContain('activeRoomTabRoomId');
    expect(header).not.toContain("activeRoom ? '채널'");
  });

  it('does not fetch or resubscribe to retired rooms during runtime recovery', () => {
    expect(chatRuntime).not.toContain("fetch('/api/rooms'");
    expect(chatRuntime).not.toContain("case 'room_message':");
    expect(chatRuntime).not.toContain("case 'room_created':");
    expect(reconnectSync).not.toContain("type: 'room_join'");
    expect(reconnectSync).not.toContain("type: 'room_read'");
    expect(reconnectSync).not.toContain('refetchActiveRoom');
    expect(urlSync).not.toContain('useRoomStore');
    expect(urlSync).not.toContain('findRoomByKey');
    expect(urlSync).toContain('if (cur.roomKey) return');
  });

  it('removes retired room UI modules and Session AI channel capabilities', () => {
    for (const file of [
      'CreateRoomModal.tsx',
      'RoomList.tsx',
      'RoomPanel.tsx',
      'RoomMembersPanel.tsx',
      'RoomMessageBubble.tsx',
      'RoomSharedResourcesPanel.tsx',
    ]) {
      expect(fs.existsSync(path.resolve(src, 'components/rooms', file))).toBe(false);
    }
    expect(aiPanel).not.toContain('share_to_channel');
    expect(aiPanel).not.toContain("contextType === 'room'");
    expect(aiPanelStore).toContain("export type AiPanelContextType = 'session'");
    expect(aiPanelStore).not.toContain('body.roomId');
  });

  it('removes Channel locations and destinations from File Exchange', () => {
    expect(fileExchange).not.toContain("type LocationKind = 'personal' | 'channel'");
    expect(fileExchange).not.toContain("scope: 'channel'");
    expect(fileExchange).not.toContain('/api/rooms/${encodeURIComponent(resourceId)}/shared-files');
    expect(fileExchange).not.toContain('채널 구성원에게 공유');
  });

  it('preserves the external AI Service deployment channel product', () => {
    expect(publicAi).toContain('channelId');
    expect(publicAi).toContain('/api/ai-service-public/');
  });
});
