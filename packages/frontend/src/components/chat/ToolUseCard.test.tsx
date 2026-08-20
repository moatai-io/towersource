// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import i18n from '../../i18n';
import { ToolChip, ToolUseCard } from './ToolUseCard';
import { useChatStore } from '../../stores/chat-store';
import { useSessionStore } from '../../stores/session-store';

beforeEach(async () => {
  vi.restoreAllMocks();
  await i18n.changeLanguage('ko');
  useChatStore.setState({
    isStreaming: false,
    sessionId: 's1',
    engineSessionId: null,
    messages: [],
    slashCommands: [],
    attachments: [],
    messageQueue: {},
  });

  useSessionStore.setState({
    sessions: [],
    activeSessionId: 's1',
    streamingSessions: new Set(),
    unreadSessions: new Set(),
    sidebarOpen: true,
    sidebarTab: 'sessions',
    searchQuery: '',
    isMobile: false,
    mobileTab: 'ai',
    mobileContextOpen: false,
    mobileTabBeforeContext: 'ai',
    activeView: 'chat',
  });
});

describe('ToolUseCard file previews', () => {
  it('links grep path inside the raw invocation payload', () => {
    const onFileClick = vi.fn();

    render(
      <ToolUseCard
        name="Grep"
        input={{ path: '/home/tower/tower/packages/frontend/src/components/chat/ToolUseCard.tsx', pattern: 'ToolUseCard' }}
        result="packages/frontend/src/components/chat/ToolUseCard.tsx:1:match"
        onFileClick={onFileClick}
        defaultExpanded={true}
      />
    );

    const link = screen.getByRole('button', { name: '/home/tower/tower/packages/frontend/src/components/chat/ToolUseCard.tsx' });
    expect(link).toHaveClass('cursor-pointer');

    fireEvent.click(link);

    expect(onFileClick).toHaveBeenCalledWith('/home/tower/tower/packages/frontend/src/components/chat/ToolUseCard.tsx');
  });

  it('links Korean directory paths inside tool results', () => {
    const onFileClick = vi.fn();
    const path = '~/workspace/projects/project-43b24a76/reports/nonsan-nangcheong/항목별_제출서류/DOCX_워드호환/';

    render(
      <ToolUseCard
        name="Bash"
        input={{ command: `ls ${path}` }}
        result={`saved: ${path}`}
        onFileClick={onFileClick}
        defaultExpanded={true}
      />
    );

    const links = screen.getAllByRole('button', { name: path });
    expect(links.length).toBeGreaterThan(0);

    fireEvent.click(links[0]);

    expect(onFileClick).toHaveBeenCalledWith(path);
  });

  it('hides completed present_file cards because the Viewer opens the artifact directly', () => {
    const path = '/home/tower/workspace/projects/tower/final/report.md';

    const { container } = render(
      <ToolUseCard
        name="present_file"
        input={{ path, split: 'right', label: 'Final report' }}
        result={JSON.stringify({ ok: true, path, split: 'right', label: 'Final report' })}
        defaultExpanded={true}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('shows a larger head/tail preview and lazy-renders full results on demand', () => {
    const result = Array.from({ length: 220 }, (_, i) => `line-${i + 1}`).join('\n');

    render(
      <ToolUseCard
        name="Bash"
        input={{ command: 'cat sample.txt' }}
        result={result}
        defaultExpanded={true}
      />
    );

    expect(screen.getByText(/line-104/)).toBeInTheDocument();
    expect(screen.getByText(/line-220/)).toBeInTheDocument();
    expect(screen.queryByText(/line-105/)).not.toBeInTheDocument();
    expect(screen.getByText(/중간 60줄 생략/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '전체 보기' }));
    expect(screen.getByText(/line-105/)).toBeInTheDocument();
  });

  it('opens full redacted output in a separate window without first rendering omitted lines in chat', () => {
    const openedDocument = document.implementation.createHTMLDocument('tool-output');
    const popup = { document: openedDocument, focus: vi.fn(), opener: window };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as any);
    const result = Array.from({ length: 220 }, (_, i) => (
      i === 104 ? 'line-105 API_KEY=fake-secret-token-1234567890' : `line-${i + 1}`
    )).join('\n');

    render(
      <ToolUseCard
        name="Bash"
        input={{ command: 'cat sample.txt' }}
        result={result}
        defaultExpanded={true}
      />
    );

    expect(screen.queryByText(/line-105/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '새 창에서 보기' }));

    expect(openSpy).toHaveBeenCalledWith('', '_blank');
    expect(openedDocument.body.textContent).toContain('line-105 API_KEY=[redacted]');
    expect(openedDocument.body.textContent).not.toContain('abcdefghijklmnop');
    expect(popup.focus).toHaveBeenCalled();
  });

  it('hides .env-like tool output in the expanded result panel', () => {
    render(
      <ToolUseCard
        name="Bash"
        input={{ command: 'cat config/.env.local' }}
        result={'OPENAI_API_KEY=fake-secret-token-verysecretvalue'}
        defaultExpanded={true}
      />
    );

    expect(screen.getByText(/채팅에서 숨겼습니다/)).toBeInTheDocument();
    expect(screen.queryByText(/verysecretvalue/)).not.toBeInTheDocument();
  });

  it('redacts common secret patterns before rendering tool output', () => {
    render(
      <ToolUseCard
        name="Bash"
        input={{ command: 'echo token' }}
        result={'Authorization: Bearer abc.def.ghi\nAPI_KEY=fake-secret-token-1234567890'}
        defaultExpanded={true}
      />
    );

    expect(screen.getByText(/Authorization: Bearer \[redacted\]/)).toBeInTheDocument();
    expect(screen.getByText(/API_KEY=\[redacted\]/)).toBeInTheDocument();
    expect(screen.queryByText(/abc\.def\.ghi/)).not.toBeInTheDocument();
    expect(screen.queryByText(/abcdefghijklmnop/)).not.toBeInTheDocument();
  });

  it('renders malformed historic Credential Vault payloads without crashing the session', () => {
    expect(() => render(
      <ToolUseCard
        name="credential_vault_input"
        input={{}}
        result="Secure credential input opened."
      />
    )).not.toThrow();
    expect(screen.getByPlaceholderText('SECRET_VALUE')).toBeInTheDocument();

    expect(() => render(
      <ToolUseCard
        name="credential_vault_input"
        input={{ inputType: 'fields', fields: [{ label: 'Legacy field', required: true }] }}
        result="Secure credential input opened."
      />
    )).not.toThrow();
    expect(screen.getByPlaceholderText('SECRET_1')).toBeInTheDocument();
  });

  it('opens Credential Vault secure input without requiring the tool card to be expanded manually', () => {
    render(
      <ToolUseCard
        name="credential_vault_input"
        input={{
          inputType: 'fields',
          id: 'supabase-management',
          provider: 'supabase',
          displayName: 'Supabase Management API 자격증명',
          scope: 'project',
          grantToCurrentProject: true,
          fields: [
            { key: 'SUPABASE_ACCESS_TOKEN', label: 'Supabase Personal Access Token', required: true },
            { key: 'SUPABASE_PROJECT_REF', label: 'Supabase Project Ref', required: true },
          ],
        }}
        result="Secure credential input opened."
      />
    );

    expect(screen.getByPlaceholderText('SUPABASE_ACCESS_TOKEN')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('SUPABASE_PROJECT_REF')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Vault에 저장' })).toBeInTheDocument();
    expect(screen.queryByText(/"SUPABASE_ACCESS_TOKEN"/)).not.toBeInTheDocument();
    expect(screen.queryByText('Secure credential input opened.')).not.toBeInTheDocument();
  });
});

describe('ToolUseCard AskUserQuestion history', () => {
  const questions = [{
    question: '배포 방식을 선택해주세요',
    options: [
      { label: '지금 배포', description: '즉시 반영합니다.' },
      { label: '검증 후 배포', description: '테스트를 먼저 통과시킵니다.' },
      { label: '이번에는 보류' },
    ],
    multiSelect: false,
  }];

  it('shows only the selected answer by default and keeps the question and alternatives on demand', () => {
    const result = JSON.stringify({
      kind: 'tower.ask_user_question_result',
      status: 'answered',
      answers: [{
        question: '배포 방식을 선택해주세요',
        selected: ['검증 후 배포'],
        answer: '검증 후 배포',
      }],
      rawAnswer: '배포 방식을 선택해주세요: 검증 후 배포',
    });

    render(<ToolUseCard name="AskUserQuestion" input={{ questions }} result={result} />);

    const compactCard = screen.getByTestId('ask-user-question-compact-history');
    expect(screen.getByLabelText('응답 완료')).toBeInTheDocument();
    expect(screen.getAllByText('검증 후 배포').length).toBeGreaterThan(0);
    expect(screen.queryByText('결정 완료')).not.toBeInTheDocument();
    expect(screen.getAllByText('배포 방식을 선택해주세요')[0]).toBeVisible();
    const optionSummary = screen.getByText('다른 선택지 2개');
    expect(compactCard).not.toHaveAttribute('open');
    fireEvent.click(optionSummary);
    expect(compactCard).toHaveAttribute('open');
    expect(screen.getAllByText('배포 방식을 선택해주세요').length).toBeGreaterThan(1);
    expect(screen.getByText('지금 배포')).toBeInTheDocument();
    expect(screen.getByText('이번에는 보류')).toBeInTheDocument();
    expect(screen.getAllByText('검증 후 배포').length).toBeGreaterThan(1);
    expect(screen.queryByText(/tower.ask_user_question_result/)).not.toBeInTheDocument();
    expect(screen.queryByText('Result')).not.toBeInTheDocument();
  });

  it('renders native Claude answers stored in the tool input', () => {
    render(
      <ToolUseCard
        name="AskUserQuestion"
        input={{ questions, answers: { '배포 방식을 선택해주세요': '검증 후 배포' } }}
      />
    );

    expect(screen.getByLabelText('응답 완료')).toBeInTheDocument();
    expect(screen.getAllByText('검증 후 배포').length).toBeGreaterThan(0);
  });

  it('renders historic plain-text answers and custom input', () => {
    render(
      <ToolUseCard
        name="AskUserQuestion"
        input={{ questions }}
        result="배포 방식을 선택해주세요: 다음 주에 다시 결정"
      />
    );

    expect(screen.getByLabelText('응답 완료')).toBeInTheDocument();
    expect(screen.getByText('다음 주에 다시 결정')).toBeInTheDocument();
    fireEvent.click(screen.getByText('다른 선택지 3개'));
    expect(screen.getByText('직접 입력 · 다음 주에 다시 결정')).toBeInTheDocument();
  });

  it('shows skipped questions without inventing a selected option', () => {
    render(
      <ToolUseCard
        name="AskUserQuestion"
        input={{ questions }}
        result="[User skipped the interactive question]"
      />
    );

    expect(screen.getByText('건너뜀')).toBeInTheDocument();
    expect(screen.queryByText('✓')).not.toBeInTheDocument();
  });

  it('renders every question and answer from a multi-question AUQ', () => {
    const multiQuestions = [
      questions[0],
      {
        question: '배포 시점을 선택해주세요',
        options: [{ label: '오늘' }, { label: '내일' }],
        multiSelect: false,
      },
    ];
    const result = JSON.stringify({
      kind: 'tower.ask_user_question_result',
      status: 'answered',
      answers: [
        { question: '배포 방식을 선택해주세요', selected: ['검증 후 배포'], answer: '검증 후 배포' },
        { question: '배포 시점을 선택해주세요', selected: ['내일'], answer: '내일' },
      ],
    });

    render(<ToolUseCard name="AskUserQuestion" input={{ questions: multiQuestions }} result={result} compact={true} />);

    const compactCard = screen.getByTestId('ask-user-question-compact-history');
    expect(screen.getAllByText('배포 방식을 선택해주세요')[0]).toBeVisible();
    expect(screen.getAllByText('배포 시점을 선택해주세요')[0]).toBeVisible();
    expect(screen.getAllByText('검증 후 배포')[0]).toBeVisible();
    expect(screen.getAllByText('내일')[0]).toBeVisible();
    expect(compactCard.querySelectorAll(':scope > summary > div:first-child > div')).toHaveLength(2);
  });

  it('hides unanswered AUQ tool history while the floating prompt is active', () => {
    const { container } = render(<ToolUseCard name="AskUserQuestion" input={{ questions }} compact={true} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps hook order stable when an unanswered AUQ becomes completed history', () => {
    const result = JSON.stringify({
      kind: 'tower.ask_user_question_result',
      status: 'answered',
      answers: [{ question: '배포 방식을 선택해주세요', selected: ['검증 후 배포'], answer: '검증 후 배포' }],
    });
    const { container, rerender } = render(
      <ToolUseCard name="AskUserQuestion" input={{ questions }} compact={true} />
    );

    expect(container).toBeEmptyDOMElement();
    expect(() => rerender(
      <ToolUseCard name="AskUserQuestion" input={{ questions }} result={result} compact={true} />
    )).not.toThrow();
    expect(screen.getByTestId('ask-user-question-compact-history')).toBeInTheDocument();
  });

  it('renders completed AUQ as a neutral two-line history row', () => {
    const result = JSON.stringify({
      kind: 'tower.ask_user_question_result',
      status: 'answered',
      answers: [{ question: '배포 방식을 선택해주세요', selected: ['검증 후 배포'], answer: '검증 후 배포' }],
    });

    render(<ToolUseCard name="AskUserQuestion" input={{ questions }} result={result} compact={true} />);

    const compactCard = screen.getByTestId('ask-user-question-compact-history');
    expect(compactCard).toHaveClass('border-y', 'py-1.5');
    expect(compactCard).not.toHaveClass('tone-card', 'tone-accent');
    expect(screen.getByLabelText('응답 완료')).toBeInTheDocument();
    expect(screen.getAllByText('검증 후 배포').length).toBeGreaterThan(0);
    expect(screen.getAllByText('배포 방식을 선택해주세요')[0]).toBeVisible();
    expect(screen.getByText('다른 선택지 2개')).toBeInTheDocument();
    expect(compactCard.querySelectorAll(':scope > summary > div:first-child > div')).toHaveLength(1);
  });
});

describe('ToolUseCard streaming state', () => {
  it('does not show running state from stale global flag when current session is idle', () => {
    useChatStore.setState({ isStreaming: true, sessionId: 's1' });
    useSessionStore.setState({ streamingSessions: new Set(['other-session']) });

    render(
      <ToolChip
        name="Bash"
        input={{ command: 'ls -la' }}
        isActive={false}
        isLast={true}
        onClick={() => {}}
      />
    );

    expect(screen.queryByText('코드를 실행해 확인하고 있습니다')).not.toBeInTheDocument();
  });

  it('shows running state when the current session is marked streaming', () => {
    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      turnStateBySession: {
        s1: {
          phase: 'tool_running',
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
          pendingMessageCount: 0,
        },
      },
    });
    useSessionStore.setState({ streamingSessions: new Set(['s1']) });

    render(
      <ToolUseCard
        name="Bash"
        input={{ command: 'ls -la' }}
        defaultExpanded={true}
        isLive={true}
      />
    );

    expect(screen.getAllByText('코드를 실행해 확인하고 있습니다').length).toBeGreaterThan(0);
  });

  it('uses English activity labels when the app language is English', async () => {
    await i18n.changeLanguage('en');
    useChatStore.setState({
      isStreaming: false,
      sessionId: 's1',
      turnStateBySession: {
        s1: {
          phase: 'tool_running',
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
          pendingMessageCount: 0,
        },
      },
    });
    useSessionStore.setState({ streamingSessions: new Set(['s1']) });

    render(
      <ToolChip
        name="Bash"
        input={{ command: 'npm test' }}
        isActive={false}
        isLive={true}
        isLast={true}
        onClick={() => {}}
      />
    );

    expect(screen.getByText('Running tests')).toBeInTheDocument();
  });

  it('uses natural English controls for long tool output', async () => {
    await i18n.changeLanguage('en');
    const result = Array.from({ length: 220 }, (_, i) => `line-${i + 1}`).join('\n');

    render(<ToolUseCard name="Bash" input={{ command: 'cat sample.txt' }} result={result} defaultExpanded={true} />);

    expect(screen.getByText('Show full output')).toBeInTheDocument();
    expect(screen.getByText('Open in new window')).toBeInTheDocument();
    expect(screen.getByText('Copy visible content')).toBeInTheDocument();
    expect(screen.getByText(/60 lines omitted from the middle/)).toBeInTheDocument();
  });
});
