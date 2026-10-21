import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { safeStr } from '../shared/parse-loose-json';
import type { PendingQuestion } from '../../stores/chat-store';
import { useShortcutStore, matchesShortcut } from '../../stores/shortcut-store';
import { useSettingsStore } from '../../stores/settings-store';

interface FloatingQuestionCardProps {
  question: PendingQuestion;
  onAnswer: (questionId: string, answer: string) => void;
  answered?: { questionId: string; answer: string } | null;
  onDismiss?: () => void;
  minimized?: boolean;
  onMinimize?: () => void;
  onRestore?: () => void;
}

type AnswerValue = string | string[];

function answerToText(answer: AnswerValue | undefined): string {
  if (Array.isArray(answer)) return answer.join(', ');
  return answer || '';
}

function hasAnswer(answer: AnswerValue | undefined): boolean {
  return Array.isArray(answer) ? answer.length > 0 : !!answer;
}

function inferBinaryConfirmationOptions(questionText: string, t: (key: string) => string): Array<{ label: string }> {
  const text = questionText.trim();
  if (!text) return [];
  const asksForTypedYesNo = /(네|예|아니오|yes|no)\s*(라고|로)?\s*(답|입력|써|작성)|type\s+(yes|no)|reply\s+(yes|no)/i.test(text);
  const asksForGoNoGo = /(승인|확인|진행|계속|실행|반영|삭제|배포|재시작|approve|confirm|proceed|continue|run|deploy|restart)/i.test(text)
    && /(할까요|하시겠습니까|해도|할지|여부|\?)/.test(text);

  return asksForTypedYesNo || asksForGoNoGo
    ? [{ label: t('confirmProceed') }, { label: t('confirmStop') }]
    : [];
}

function getQuestionOptions(q: any, t: (key: string) => string): Array<{ label: string; description?: string }> {
  const options = Array.isArray(q.options) ? q.options : [];
  return options.length > 0 ? options : inferBinaryConfirmationOptions(safeStr(q.question || q.prompt || q.title), t);
}

export function FloatingQuestionCard({ question, onAnswer, answered, onDismiss, minimized = false, onMinimize, onRestore }: FloatingQuestionCardProps) {
  const { t } = useTranslation('chat');
  const bindings = useShortcutStore(s => s.bindings);
  const cardRef = useRef<HTMLDivElement>(null);
  const [answers, setAnswers] = useState<Record<number, AnswerValue>>({});
  const prevQuestionId = useRef(question.questionId);
  const [otherOpen, setOtherOpen] = useState<Record<number, boolean>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});
  const otherInputRefs = useRef<Record<number, HTMLInputElement | HTMLTextAreaElement | null>>({});
  const activeOtherIndex = useRef<number | null>(null);

  useEffect(() => {
    if (question.questionId !== prevQuestionId.current) {
      setAnswers({});
      setOtherOpen({});
      setOtherText({});
      prevQuestionId.current = question.questionId;
    }
  }, [question.questionId]);

  useEffect(() => {
    const qi = activeOtherIndex.current;
    if (qi === null || !otherOpen[qi]) return;
    const input = otherInputRefs.current[qi];
    input?.focus({ preventScroll: true });
    // Reveal the entire input row, including its action, inside the body.
    input?.parentElement?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [otherOpen]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const revealFocusedInput = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const input = Object.values(otherInputRefs.current)
          .find(element => element === document.activeElement);
        input?.parentElement?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      });
    };
    viewport.addEventListener('resize', revealFocusedInput);
    return () => {
      viewport.removeEventListener('resize', revealFocusedInput);
      cancelAnimationFrame(frame);
    };
  }, []);

  const totalQuestions = question.questions.length;
  const getSubmittableAnswers = (baseAnswers: Record<number, AnswerValue> = answers) => {
    const nextAnswers: Record<number, AnswerValue> = { ...baseAnswers };
    question.questions.forEach((q, qi) => {
      const options = getQuestionOptions(q, t);
      if (options.length === 0) {
        const draftText = (otherText[qi] || '').trim();
        if (draftText) nextAnswers[qi] = draftText;
      }
    });
    return nextAnswers;
  };
  const answeredCount = Object.values(getSubmittableAnswers()).filter(hasAnswer).length;
  const isSubmitting = question.submissionStatus === 'submitting';
  const canSubmit = !answered && !isSubmitting && answeredCount > 0;
  const isAnswered = !!answered;

  // Keep the global listener stable while reading current answers and bindings.
  const shortcutHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {});

  const handleSelect = (qi: number, label: string, multiSelect?: boolean) => {
    if (isAnswered || isSubmitting) return;
    setOtherOpen(prev => ({ ...prev, [qi]: false }));
    setAnswers(prev => {
      if (!multiSelect) return { ...prev, [qi]: label };
      const current = Array.isArray(prev[qi]) ? prev[qi] as string[] : [];
      const next = current.includes(label)
        ? current.filter(item => item !== label)
        : [...current, label];
      return { ...prev, [qi]: next };
    });
  };

  const sendAnswers = (nextAnswers: Record<number, AnswerValue>) => {
    if (isAnswered || !Object.values(nextAnswers).some(hasAnswer)) return;
    const combined = question.questions
      .map((q, i) => `${q.question}: ${answerToText(nextAnswers[i]) || t('unanswered')}`)
      .join('\n');
    onAnswer(question.questionId, combined);
  };

  const submitAnswers = () => sendAnswers(getSubmittableAnswers());

  shortcutHandlerRef.current = (event) => {
    if (minimized || isAnswered || isSubmitting || useSettingsStore.getState().isOpen
      || document.querySelector('[aria-modal="true"]')
      || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) return;
    const target = event.target instanceof Element ? event.target : null;
    const focused = document.activeElement;
    const isEditing = (element: Element | null) => !!element?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
    if (isEditing(target) || isEditing(focused)) return;
    if (matchesShortcut(event, bindings['question.submit'])) {
      if (!canSubmit) return;
      event.preventDefault();
      submitAnswers();
      return;
    }
    const optionIndex = Array.from({ length: 9 }, (_, index) => index)
      .find(index => matchesShortcut(event, bindings[`question.option${index + 1}`]));
    if (optionIndex === undefined) return;
    const focusedQuestion = cardRef.current?.contains(focused)
      ? focused?.closest<HTMLElement>('[data-question-index]') : null;
    const unansweredIndex = question.questions.findIndex((_, qi) => !hasAnswer(getSubmittableAnswers()[qi]));
    const qi = focusedQuestion ? Number(focusedQuestion.dataset.questionIndex) : Math.max(0, unansweredIndex);
    const q = question.questions[qi];
    const option = q && getQuestionOptions(q, t)[optionIndex];
    if (!option) return;
    event.preventDefault();
    handleSelect(qi, option.label, q.multiSelect);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => shortcutHandlerRef.current(event);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleOtherSubmit = (qi: number, sendImmediately = false, immediateText?: string) => {
    // Mobile keyboards and paste can dispatch Enter before React has committed
    // the latest controlled-input state. Prefer the event's live DOM value for
    // that immediate-submit path so the final characters are never dropped.
    const text = (immediateText ?? otherText[qi] ?? '').trim();
    if (!text) return;
    const multiSelect = question.questions[qi]?.multiSelect;
    const current = answers[qi];
    const nextValue = multiSelect
      ? [...(Array.isArray(current) ? current : current ? [current] : []), text]
      : text;
    const nextAnswers = { ...answers, [qi]: nextValue };
    setAnswers(nextAnswers);
    setOtherOpen(prev => ({ ...prev, [qi]: false }));
    setOtherText(prev => ({ ...prev, [qi]: '' }));
    if (sendImmediately) sendAnswers(nextAnswers);
  };

  const handleSkip = () => {
    if (isAnswered) return;
    onAnswer(question.questionId, '[User skipped the interactive question]');
  };

  if (minimized) {
    return (
      <button
        type="button"
        data-testid="floating-question-minimized"
        onClick={onRestore}
        aria-expanded="false"
        aria-label={t('expandQuestion')}
        className="flex min-h-[44px] w-full items-center gap-3 rounded-2xl border px-4 py-2.5 text-left shadow-lg transition hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 dark:hover:bg-white/5"
        style={{
          background: 'var(--th-bg-primary)',
          borderColor: 'var(--th-q-pending-border)',
          color: 'var(--th-text-primary)',
          ['--tw-ring-color' as any]: 'var(--th-q-pending-border)',
        }}
      >
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm font-semibold"
          style={{ background: 'var(--th-q-pending-btn-bg)', color: 'var(--th-q-pending-btn-text)' }}
          aria-hidden="true"
        >
          ?
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold">{t('questionNeedsAnswer')}</span>
          <span className="block truncate text-[12px]" style={{ color: 'var(--th-text-muted)' }}>
            {safeStr(question.questions[0]?.question || t('reopenQuestionHint'))}
          </span>
        </span>
        <span className="shrink-0 text-[12px] font-semibold" style={{ color: 'var(--th-text-secondary)' }}>{t('reopenQuestion')}</span>
      </button>
    );
  }

  return (
    <div
      ref={cardRef}
      data-testid="floating-question-card"
      className="mx-auto flex min-h-0 max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-[20px] border shadow-[0_18px_52px_rgba(0,0,0,0.22)] backdrop-blur-xl transition-all duration-300"
      style={{
        background: 'color-mix(in srgb, var(--th-bg-primary) 96%, transparent)',
        borderColor: isAnswered ? 'var(--th-q-done-border)' : 'var(--th-border-subtle)',
        animation: 'slideUp 0.22s ease-out',
      }}
    >
      <span className="sr-only">{isAnswered ? 'Answered' : isSubmitting ? 'Submitting answer' : 'AI is asking'}</span>
      <div data-testid="question-scroll-body" className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-py-4 px-4 py-4 md:px-5 md:py-5">
        {question.submissionStatus === 'send_failed' && (
          <div role="alert" className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-200">
            {t('runtime.questionAnswerFailed')}
          </div>
        )}
        {question.questions.map((q, qi) => {
          const answeredParts = answered?.answer.split('\n') || [];
          const storedAnswer = answers[qi];
          const answeredText = answeredParts[qi]?.split(': ').slice(1).join(': ') || null;
          const currentText = answerToText(storedAnswer) || answeredText;
          const qDone = !!currentText;
          const options = getQuestionOptions(q, t);
          const optionLabels = new Set(options.map(opt => opt.label));
          const customAnswers = (Array.isArray(storedAnswer) ? storedAnswer : storedAnswer ? [storedAnswer] : [])
            .filter(value => !optionLabels.has(value));

          return (
            <div key={qi} data-question-index={qi} className="space-y-2">
              <div className="flex items-start gap-2.5">
                <div className="min-w-0 flex-1 text-[15px] md:text-[16px] font-medium leading-snug" style={{ color: 'var(--th-text-primary)' }}>
                  {safeStr(q.question || (q as any).prompt || (q as any).title)}
                </div>
                {!isAnswered && qi === 0 && onMinimize && (
                  <button
                    type="button"
                    onClick={onMinimize}
                    aria-expanded="true"
                    aria-label={t('minimizeQuestion')}
                    className="-mt-1 flex min-h-[40px] min-w-[40px] shrink-0 items-center justify-center rounded-full transition hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 dark:hover:bg-white/10"
                    style={{ color: 'var(--th-text-secondary)', ['--tw-ring-color' as any]: 'var(--th-q-pending-border)' }}
                    title={t('minimizeQuestionHint')}
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14" />
                    </svg>
                  </button>
                )}
                {!isAnswered && onDismiss && (
                  <button
                    type="button"
                    onClick={onDismiss}
                    className="-mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10"
                    title={t('dismissEsc')}
                    aria-label={t('dismissQuestion')}
                    style={{ color: 'var(--th-text-muted)' }}
                  >
                    <svg className="h-4.5 w-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>

              {options.length > 0 && (
                <div
                  data-testid={`question-options-${qi}`}
                  className="rounded-xl"
                  style={{ borderColor: 'var(--th-border-subtle)' }}
                >
                  {options.map((opt, oi) => {
                    const isSelected = Array.isArray(storedAnswer)
                      ? storedAnswer.includes(opt.label)
                      : currentText === opt.label;
                    const rowDisabled = isAnswered;
                    return (
                      <button
                        key={oi}
                        type="button"
                        aria-label={opt.label}
                        aria-pressed={isSelected}
                        onClick={() => handleSelect(qi, opt.label, q.multiSelect)}
                        disabled={rowDisabled || isSubmitting}
                        className="group flex w-full items-center gap-3 border-b px-2.5 py-2 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5 last:border-b-0 disabled:cursor-default disabled:hover:bg-transparent"
                        style={{
                          borderColor: 'var(--th-border-subtle)',
                          ...(isSelected ? { background: 'var(--th-q-done-selected-bg)' } : {}),
                        }}
                      >
                        <span
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[14px] font-medium"
                          style={{
                            background: isSelected
                              ? 'var(--th-q-done-selected-border)'
                              : 'color-mix(in srgb, var(--th-text-muted) 12%, transparent)',
                            color: isSelected ? 'var(--th-q-done-selected-text)' : 'var(--th-text-secondary)',
                          }}
                        >
                          {q.multiSelect && isSelected ? '✓' : oi + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block whitespace-normal break-words text-[14px] leading-snug md:text-[15px]" style={{ color: isSelected ? 'var(--th-q-done-selected-text)' : 'var(--th-text-primary)' }}>
                            {safeStr(opt.label)}
                          </span>
                          {opt.description && (
                            <span className="mt-1 block whitespace-normal break-words text-[12px] leading-relaxed" style={{ color: 'var(--th-text-muted)' }}>
                              {safeStr(opt.description)}
                            </span>
                          )}
                        </span>
                        {!rowDisabled && oi === 0 && !qDone && (
                          <svg className="h-3.5 w-3.5 opacity-45 transition-opacity group-hover:opacity-70" style={{ color: 'var(--th-text-muted)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 17L17 7m0 0H8m9 0v9" />
                          </svg>
                        )}
                      </button>
                    );
                  })}

                  {customAnswers.map(customAnswer => (
                    <div
                      key={customAnswer}
                      role="status"
                      aria-label={t('customAnswerAddedLabel', { answer: customAnswer })}
                      className="flex w-full items-center gap-3 border-b px-2.5 py-2 text-left"
                      style={{
                        borderColor: 'var(--th-border-subtle)',
                        background: 'var(--th-q-done-selected-bg)',
                      }}
                    >
                      <span
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[14px] font-medium"
                        style={{
                          background: 'var(--th-q-done-selected-border)',
                          color: 'var(--th-q-done-selected-text)',
                        }}
                      >
                        ✓
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14px] md:text-[15px]" style={{ color: 'var(--th-q-done-selected-text)' }}>
                          {safeStr(customAnswer)}
                        </span>
                        <span className="mt-0.5 block text-[12px]" style={{ color: 'var(--th-text-muted)' }}>
                          {t('customAnswerAdded')}
                        </span>
                      </span>
                    </div>
                  ))}

                  {!isAnswered && !otherOpen[qi] && (
                    <button
                      type="button"
                      onClick={() => {
                        activeOtherIndex.current = qi;
                        setOtherOpen(prev => ({ ...prev, [qi]: true }));
                      }}
                      className="flex w-full items-center gap-3 px-2.5 py-2 text-left transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                    >
                      <span
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                        style={{ background: 'color-mix(in srgb, var(--th-text-muted) 10%, transparent)', color: 'var(--th-text-secondary)' }}
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536M4 20h4.5L19 9.5a2.5 2.5 0 00-3.5-3.5L5 16.5V20z" />
                        </svg>
                      </span>
                      <span className="text-[14px] md:text-[15px]" style={{ color: 'var(--th-text-secondary)' }}>{t('other')}</span>
                    </button>
                  )}
                </div>
              )}

              {!isAnswered && (otherOpen[qi] || options.length === 0) && (
                <div
                  data-testid={options.length === 0 ? `question-freeform-${qi}` : undefined}
                  className={`flex w-full min-w-0 gap-2 ${options.length === 0 ? 'mb-5 flex-col' : ''}`}
                >
                  {options.length === 0 ? (
                    <textarea
                      ref={element => { otherInputRefs.current[qi] = element; }}
                      value={otherText[qi] || ''}
                      rows={3}
                      onChange={e => setOtherText(prev => ({ ...prev, [qi]: e.target.value }))}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          e.stopPropagation();
                          handleOtherSubmit(qi, true, e.currentTarget.value);
                        }
                      }}
                      placeholder={t('typeYourAnswer')}
                      className="block min-h-[128px] w-full min-w-0 flex-1 resize-y rounded-xl border px-4 py-3.5 text-[14px] leading-relaxed outline-none focus:ring-1"
                      style={{
                        background: 'var(--th-bg-secondary)',
                        borderColor: 'var(--th-border-subtle)',
                        color: 'var(--th-text-primary)',
                        ['--tw-ring-color' as any]: 'var(--th-q-pending-border)',
                      }}
                    />
                  ) : (
                    <input
                      ref={element => { otherInputRefs.current[qi] = element; }}
                      type="text"
                      value={otherText[qi] || ''}
                      onChange={e => setOtherText(prev => ({ ...prev, [qi]: e.target.value }))}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          e.stopPropagation();
                          handleOtherSubmit(qi, true, e.currentTarget.value);
                        }
                        if (e.key === 'Escape') setOtherOpen(prev => ({ ...prev, [qi]: false }));
                      }}
                      placeholder={t('typeYourAnswer')}
                      className="min-h-[44px] min-w-0 flex-1 rounded-lg border px-2.5 text-[16px] md:text-[14px] outline-none focus:ring-2"
                      style={{
                        background: 'var(--th-bg-secondary)',
                        borderColor: 'var(--th-border-subtle)',
                        color: 'var(--th-text-primary)',
                        ['--tw-ring-color' as any]: 'var(--th-q-pending-border)',
                      }}
                    />
                  )}
                  {options.length > 0 && (
                    <button
                      type="button"
                      onClick={() => handleOtherSubmit(qi)}
                      disabled={!(otherText[qi] || '').trim()}
                      className="min-h-[44px] shrink-0 rounded-lg px-3 text-[13px] font-semibold shadow-sm transition disabled:opacity-40"
                      style={{ background: 'var(--th-q-pending-btn-bg)', color: 'var(--th-q-pending-btn-text)' }}
                    >
                      {t('add')}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}

      </div>

        {!isAnswered && (
          <div
            data-testid="question-actions"
            className="flex shrink-0 justify-end gap-2 border-t px-4 py-3 md:px-5"
            style={{
              background: 'color-mix(in srgb, var(--th-bg-primary) 96%, transparent)',
              borderColor: 'var(--th-border-subtle)',
            }}
          >
            <button
              type="button"
              onClick={handleSkip}
              className="min-h-[40px] rounded-lg border px-3 py-2 text-[13px] font-semibold shadow-sm transition hover:bg-black/5 dark:hover:bg-white/5"
              style={{
                background: 'var(--th-bg-secondary)',
                borderColor: 'var(--th-border-subtle)',
                color: 'var(--th-text-primary)',
              }}
            >
              {t('skip')}
            </button>
            <button
              type="button"
              onClick={submitAnswers}
              disabled={!canSubmit}
              className="min-h-[40px] rounded-lg px-4 py-2 text-[13px] font-semibold shadow-sm transition disabled:opacity-40"
              style={{ background: 'var(--th-q-pending-btn-bg)', color: 'var(--th-q-pending-btn-text)' }}
            >
              {isSubmitting ? t('working') : t('sendResponse')}
            </button>
          </div>
        )}
    </div>
  );
}
