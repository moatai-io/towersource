import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const surface = fs.readFileSync(path.resolve(import.meta.dirname, './FileExchangeSurface.tsx'), 'utf8');
const materials = fs.readFileSync(path.resolve(import.meta.dirname, '../../components/personal-space/PersonalMaterialsView.tsx'), 'utf8');
const input = fs.readFileSync(path.resolve(import.meta.dirname, '../../components/chat/InputBox.tsx'), 'utf8');

describe('File Exchange UI integration', () => {
  it('keeps project collections stable so an empty Personal folder does not refetch on every render', () => {
    expect(surface).toContain('const allProjects = useProjectStore');
    expect(surface).toContain('React.useMemo(() => allProjects.filter');
    expect(surface).not.toContain('useProjectStore(state => state.projects).filter');
    expect(surface).not.toContain('useRoomStore');
  });

  it('owns the C option location switch in one feature surface', () => {
    for (const label of ['내 파일', 'AI 팀원']) expect(surface).toContain(label);
    expect(surface).not.toContain("['channel','채널']");
    expect(surface).toContain("useState<LocationKind>('personal')");
    expect(materials).toContain('<FileExchangeSurface personalOnly');
  });

  it('uses the opaque drag contract and imports into the active session', () => {
    expect(surface).toContain('FILE_EXCHANGE_DRAG_TYPE');
    expect(input).toContain("application/x-tower-file-exchange");
    expect(input).toContain('decodeExchangeDrag');
    expect(input).toContain("{ scope: 'session', sessionId }");
  });

  it('lets the personal file table collapse without a fixed 640px floor', () => {
    expect(surface).not.toContain('min-w-[640px]');
    expect(surface).toContain("grid-cols-[32px_minmax(0,1fr)_72px]");
    expect(surface).toContain("hidden min-[560px]:block");
    expect(surface).toContain("min-[420px]:flex-row");
  });

  it('keeps the personal Viewer actions readable and removes the duplicated inner heading', () => {
    expect(surface).toContain('whitespace-normal break-keep');
    expect(surface).toContain("aria-label={personalOnly ? '내 파일' : '내 파일과 팀의 저장소'}");
    expect(surface).toContain('{!personalOnly && <div');
    expect(surface).not.toContain("{personalOnly ? 'PERSONAL FILES' : 'FILE EXCHANGE'}");
  });

  it('provides one destination picker as the mobile-equivalent transfer action', () => {
    expect(surface).toContain('어디로 보낼까요?');
    expect(surface).toContain('대화, AI 팀원 검색');
    expect(surface).toContain("label: '현재 대화'");
    expect(surface).toContain("label: '내 자료'");
    expect(surface).toContain('AI 팀원 작업공간에 사본 저장');
    expect(surface).not.toContain('채널 구성원에게 공유');
    expect(surface).not.toContain("scope: 'channel'");
    expect(surface).toContain("onClick={() => void sendSelection(choice)}");
    expect(surface).toContain("useChatStore.getState().addAttachment");
    expect(surface).toContain("sessionAttachmentId: result.attachmentId");
  });

  it('keeps the destination dialog keyboard-dismissable and restores trigger focus', () => {
    expect(surface).toContain("event.key === 'Escape'");
    expect(surface).toContain('closeDestinationPicker(true)');
    expect(surface).toContain('sendButtonRef.current?.focus()');
    expect(surface).toContain('aria-haspopup="dialog"');
    expect(surface).toContain('aria-modal="true"');
    expect(surface).toContain('aria-labelledby="file-destination-title"');
  });

  it('offers an actionable receipt for durable destinations', () => {
    expect(surface).toContain("label: choice.destination.scope === 'project' ? '작업공간 열기'");
    expect(surface).not.toContain("'채널 열기'");
    expect(surface).toContain('openReceiptResult(choice.destination, lastResult)');
  });

  it('does not attach a fixed Korean particle directly to an open filename', () => {
    expect(surface).toContain('formatNamedItem(item.name)');
    expect(surface).not.toContain('${item.name}을 전달할까요?');
  });
});
