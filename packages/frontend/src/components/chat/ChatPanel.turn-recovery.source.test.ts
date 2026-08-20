import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const chatPanelPath = path.resolve(import.meta.dirname, 'ChatPanel.tsx');
const inputBoxPath = path.resolve(import.meta.dirname, 'InputBox.tsx');
const runtimePath = path.resolve(import.meta.dirname, '../../hooks/useChatRuntime.ts');
const chatPanel = fs.readFileSync(chatPanelPath, 'utf8');
const inputBox = fs.readFileSync(inputBoxPath, 'utf8');
const runtime = fs.readFileSync(runtimePath, 'utf8');

describe('Chat recovery surface contract', () => {
  it('does not render a pseudo-continuation recovery pill or card', () => {
    expect(chatPanel).not.toContain('showRecoveryStatus');
    expect(chatPanel).not.toContain('이어서 처리하지 못했어요');
    expect(chatPanel).not.toContain('작업을 마치지 못했어요');
    expect(chatPanel).not.toContain("source: 'turn-recovery'");
    expect(chatPanel).not.toContain('상태 확인 후 이어가기');
  });

  it('renders user stop as one neutral chat-timeline box without stop toasts', () => {
    expect(chatPanel).toContain('data-testid="turn-stopped-status"');
    expect(chatPanel).toContain("t('stoppedTurn.title')");
    expect(chatPanel).toContain("t('stoppedTurn.savedHint')");
    expect(chatPanel).toContain("activeTurnTerminal.reason === 'forced_stop'");
    const stopStateCase = runtime.match(/case 'turn_stop_state':[\s\S]*?\n      case 'session_status_check':/)?.[0] || '';
    expect(stopStateCase).not.toContain("toastSuccess('현재 단계까지 마치고 멈췄습니다.')");
    expect(stopStateCase).not.toContain("toastWarning('즉시 중단했습니다.");
    expect(stopStateCase).not.toContain("toastInfo(data.waitingFor");
  });

  it('keeps the existing real continue action', () => {
    expect(inputBox).toContain("onClick={() => sendQuickReply(t('continueRequest'))}");
    expect(inputBox).toContain("t('quickContinue')");
    expect(inputBox).not.toContain("'turn-recovery'");
  });

  it('keeps resume_failed out of toast, transcript, and draft recovery surfaces', () => {
    const resumeFailedCase = runtime.match(/case 'resume_failed':[\s\S]*?\n      }/)?.[0] || '';
    expect(resumeFailedCase).toContain('diagnostic lifecycle events');
    expect(resumeFailedCase).not.toContain('toastInfo(');
    expect(resumeFailedCase).not.toContain('toastWarning(');
    expect(resumeFailedCase).not.toContain('addMessage');
    expect(resumeFailedCase).not.toContain('markSessionRunWaitingRetry');
    expect(resumeFailedCase).not.toContain('errorMessage');
  });
});
