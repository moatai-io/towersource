// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { FloatingQuestionCard } from './FloatingQuestionCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => ({
      other: '기타',
      add: '추가',
      skip: '건너뛰기',
      sendResponse: '응답 보내기',
      customAnswerAdded: '직접 입력 · 추가됨',
      customAnswerAddedLabel: `추가됨: ${params?.answer || ''}`,
      typeYourAnswer: '직접 답장…',
      confirmProceed: '예, 진행',
      confirmStop: '아니오, 중단',
      unanswered: '[미응답]',
      expandQuestion: '질문 다시 펼치기',
      questionNeedsAnswer: '답변이 필요한 질문이 있습니다',
      reopenQuestionHint: '질문을 다시 열어 확인하세요',
      reopenQuestion: '다시 열기',
      minimizeQuestion: '질문 최소화',
      minimizeQuestionHint: '질문을 최소화하고 대화 내용 보기',
    } as Record<string, string>)[key] || key,
  }),
}));

const question = {
  questionId: 'question-1',
  questions: [
    {
      question: '어떤 방식이 좋나요?',
      options: [{ label: '첫 번째', description: '기본 선택지' }],
      multiSelect: false,
    },
  ],
};

describe('FloatingQuestionCard 레이아웃과 입력 피드백', () => {
  it('질문을 최소화하면 compact bar로 바뀌고 다시 펼칠 수 있다', () => {
    const onMinimize = vi.fn();
    const onRestore = vi.fn();
    const { rerender } = render(
      <FloatingQuestionCard question={question as any} onAnswer={vi.fn()} onMinimize={onMinimize} />,
    );

    fireEvent.click(screen.getByRole('button', { name: '질문 최소화' }));
    expect(onMinimize).toHaveBeenCalledOnce();

    rerender(
      <FloatingQuestionCard question={question as any} onAnswer={vi.fn()} minimized onRestore={onRestore} />,
    );
    const restore = screen.getByRole('button', { name: '질문 다시 펼치기' });
    expect(restore).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('답변이 필요한 질문이 있습니다')).toBeInTheDocument();
    expect(screen.getByText('어떤 방식이 좋나요?')).toBeInTheDocument();

    fireEvent.click(restore);
    expect(onRestore).toHaveBeenCalledOnce();
  });

  it('최소화 버튼은 키보드 포커스와 터치 hit area를 제공한다', () => {
    render(<FloatingQuestionCard question={question as any} onAnswer={vi.fn()} onMinimize={vi.fn()} />);

    const minimize = screen.getByRole('button', { name: '질문 최소화' });
    expect(minimize).toHaveAttribute('aria-expanded', 'true');
    expect(minimize).toHaveClass('min-h-[40px]', 'min-w-[40px]', 'focus-visible:ring-2');
  });

  it('긴 질문에서도 카드 내부가 스크롤되고 응답 액션은 하단에 고정된다', () => {
    render(<FloatingQuestionCard question={question as any} onAnswer={vi.fn()} />);

    expect(screen.getByTestId('floating-question-card')).toHaveClass('max-h-full', 'w-full');
    const submit = screen.getByRole('button', { name: '응답 보내기' });
    expect(submit.parentElement).toHaveClass('sticky', 'bottom-0');
  });

  it('선택지가 없는 질문은 폭과 높이를 확보한 자유 입력 textarea를 표시한다', () => {
    const freeformQuestion = {
      ...question,
      questions: [{ question: '의견을 자유롭게 적어주세요', options: [], multiSelect: false }],
    };
    render(<FloatingQuestionCard question={freeformQuestion as any} onAnswer={vi.fn()} />);

    const region = screen.getByTestId('question-freeform-0');
    const input = screen.getByRole('textbox');
    expect(region).toHaveClass('w-full', 'min-w-0', 'mb-5', 'flex-col');
    expect(input.tagName).toBe('TEXTAREA');
    expect(input).toHaveAttribute('rows', '3');
    expect(input).toHaveClass('block', 'min-h-[128px]', 'w-full', 'min-w-0', 'py-3.5', 'focus:ring-1');
    expect(screen.queryByRole('button', { name: '추가' })).not.toBeInTheDocument();
  });

  it('선택지 없는 확인형 질문은 자유 입력 대신 예/아니오 선택지로 표시한다', () => {
    const confirmationQuestion = {
      ...question,
      questions: [{ question: '진행하려면 네라고 답해주세요.', options: [], multiSelect: false }],
    };
    render(<FloatingQuestionCard question={confirmationQuestion as any} onAnswer={vi.fn()} />);

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '예, 진행' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '아니오, 중단' })).toBeInTheDocument();
  });

  it('선택지 없는 자유 입력은 입력 초안만으로 하단 응답 버튼을 활성화한다', () => {
    const onAnswer = vi.fn();
    const freeformQuestion = {
      ...question,
      questions: [{ question: '의견을 자유롭게 적어주세요', options: [], multiSelect: false }],
    };
    render(<FloatingQuestionCard question={freeformQuestion as any} onAnswer={onAnswer} />);

    const input = screen.getByRole('textbox');
    const submit = screen.getByRole('button', { name: '응답 보내기' });
    expect(submit).toBeDisabled();

    fireEvent.change(input, { target: { value: '하단 버튼으로 바로 보낼 답변' } });
    expect(submit).toBeEnabled();

    fireEvent.click(submit);
    expect(onAnswer).toHaveBeenCalledWith('question-1', '의견을 자유롭게 적어주세요: 하단 버튼으로 바로 보낼 답변');
  });

  it('선택지 없는 자유 입력은 Ctrl+Enter로 즉시 응답을 전송한다', () => {
    const onAnswer = vi.fn();
    const freeformQuestion = {
      ...question,
      questions: [{ question: '의견을 자유롭게 적어주세요', options: [], multiSelect: false }],
    };
    render(<FloatingQuestionCard question={freeformQuestion as any} onAnswer={onAnswer} />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '충분히 긴 자유 답변' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', ctrlKey: true });

    expect(onAnswer).toHaveBeenCalledWith('question-1', '의견을 자유롭게 적어주세요: 충분히 긴 자유 답변');
  });

  it.each([
    ['Enter', (input: HTMLElement) => fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })],
    ['추가 버튼', () => fireEvent.click(screen.getByRole('button', { name: '추가' }))],
  ])('%s로 추가한 직접 입력을 즉시 선택 상태로 표시한다', (_name, submit) => {
    render(<FloatingQuestionCard question={question as any} onAnswer={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '기타' }));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '직접 작성한 답변' } });
    submit(input);

    expect(screen.getByRole('status', { name: '추가됨: 직접 작성한 답변' })).toBeInTheDocument();
    expect(screen.getByText('직접 입력 · 추가됨')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('직접 작성한 답변')).not.toBeInTheDocument();
  });

  it('기타 입력에서 Enter를 누르면 입력값을 포함해 즉시 응답을 전송한다', () => {
    const onAnswer = vi.fn();
    render(<FloatingQuestionCard question={question as any} onAnswer={onAnswer} />);

    fireEvent.click(screen.getByRole('button', { name: '기타' }));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '직접 작성한 답변' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(onAnswer).toHaveBeenCalledWith('question-1', '어떤 방식이 좋나요?: 직접 작성한 답변');
  });

  it('모바일 입력 상태 반영 전 Enter가 와도 DOM의 최신 기타 답변을 전송한다', () => {
    const onAnswer = vi.fn();
    render(<FloatingQuestionCard question={question as any} onAnswer={onAnswer} />);

    fireEvent.click(screen.getByRole('button', { name: '기타' }));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    // React onChange를 거치지 않은 최신 DOM 값은 모바일 IME/paste 직후의
    // keydown 순서를 재현한다.
    input.value = '상태보다 최신인 모바일 답변';
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(onAnswer).toHaveBeenCalledWith('question-1', '어떤 방식이 좋나요?: 상태보다 최신인 모바일 답변');
  });

  it('다중 선택 후 선택지에 포커스한 채 Enter를 누르면 선택 결과를 즉시 전송한다', () => {
    const onAnswer = vi.fn();
    const multiQuestion = {
      ...question,
      questions: [{
        question: '필요한 항목을 고르세요',
        options: [{ label: '첫 번째' }, { label: '두 번째' }],
        multiSelect: true,
      }],
    };
    render(<FloatingQuestionCard question={multiQuestion as any} onAnswer={onAnswer} />);

    fireEvent.click(screen.getByRole('button', { name: '첫 번째' }));
    const secondOption = screen.getByRole('button', { name: '두 번째' });
    fireEvent.click(secondOption);
    fireEvent.keyDown(secondOption, { key: 'Enter', code: 'Enter' });

    expect(onAnswer).toHaveBeenCalledWith('question-1', '필요한 항목을 고르세요: 첫 번째, 두 번째');
  });

  it('모바일에서 긴 선택지와 설명을 여러 줄로 표시하고 선택지 목록을 스크롤할 수 있다', () => {
    const longQuestion = {
      ...question,
      questions: [{
        question: '어떤 방식이 좋나요?',
        options: [{
          label: '모바일 화면에서도 생략되지 않고 여러 줄로 읽혀야 하는 매우 긴 선택지입니다',
          description: '설명 역시 말줄임표로 잘리지 않고 필요한 만큼 여러 줄로 표시됩니다.',
        }],
        multiSelect: false,
      }],
    };
    render(<FloatingQuestionCard question={longQuestion as any} onAnswer={vi.fn()} />);

    expect(screen.getByTestId('question-options-0')).toHaveClass('overflow-y-auto', 'max-h-[42vh]');
    expect(screen.getByText(longQuestion.questions[0].options[0].label)).toHaveClass('whitespace-normal', 'break-words');
    expect(screen.getByText(longQuestion.questions[0].options[0].description)).toHaveClass('whitespace-normal', 'break-words');
  });
});
