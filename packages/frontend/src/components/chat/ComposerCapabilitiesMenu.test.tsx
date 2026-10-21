// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposerCapabilitiesMenu } from './ComposerCapabilitiesMenu';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, options: { defaultValue: string }) => options.defaultValue }) }));
vi.mock('../../stores/settings-store', () => ({ useSettingsStore: { getState: () => ({ setSkillsBrowserOpen: vi.fn(), setCapabilityProjectId: vi.fn() }) } }));
afterEach(cleanup);
const commands = [{ name: 'meeting-prep', canonical: '/meeting-prep', source: 'skills' as const, kind: 'skill' as const, description: '회의 준비' }];

describe('ComposerCapabilitiesMenu', () => {
  it('preserves file upload and disables only the attachment action', () => {
    const attach = vi.fn();
    render(<ComposerCapabilitiesMenu commands={commands} onSelectSkill={vi.fn()} onAttach={attach} attachmentDisabled={false} />);
    fireEvent.click(screen.getByLabelText('파일·스킬·커넥터 추가'));
    fireEvent.click(screen.getByText('파일 추가'));
    expect(attach).toHaveBeenCalledOnce();
    expect(screen.queryByText('스킬')).toBeNull();
  });
  it('selects the existing canonical slash command rather than claiming execution', () => {
    const select = vi.fn();
    render(<ComposerCapabilitiesMenu commands={commands} onSelectSkill={select} onAttach={vi.fn()} attachmentDisabled />);
    fireEvent.click(screen.getByLabelText('파일·스킬·커넥터 추가'));
    expect(screen.getByText('파일 추가').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByText('스킬'));
    fireEvent.change(screen.getByLabelText('스킬 검색'), { target: { value: '회의' } });
    fireEvent.click(screen.getByText('meeting-prep'));
    expect(select).toHaveBeenCalledWith('/meeting-prep');
  });
  it('closes on Escape and returns focus to the trigger', () => {
    render(<ComposerCapabilitiesMenu commands={commands} onSelectSkill={vi.fn()} onAttach={vi.fn()} attachmentDisabled={false} />);
    const trigger = screen.getByLabelText('파일·스킬·커넥터 추가');
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByText('파일 추가'), { key: 'Escape' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });
});
