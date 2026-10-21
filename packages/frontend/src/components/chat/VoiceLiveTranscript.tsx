import { useTranslation } from 'react-i18next';
import type { VoiceTranscriptState, VoiceSentenceState } from './VoiceLiveTranscript.reducer';

interface VoiceLiveTranscriptProps {
  transcript: VoiceTranscriptState;
  audioPlaying: boolean;
}

/** Product register: one reading column, theme-native ink, no interim live announcements. */
export function VoiceLiveTranscript({ transcript, audioPlaying }: VoiceLiveTranscriptProps) {
  const { t } = useTranslation('chat');
  const label = (state: VoiceSentenceState) => {
    switch (state) {
      case 'queued': return t('voice.live.queued', { defaultValue: '음성 준비 중' });
      case 'speaking': return audioPlaying
        ? t('voice.live.speaking', { defaultValue: '재생 중 · 전송 기준' })
        : t('voice.live.transmitting', { defaultValue: '음성 전송 중 · 재생 미확인' });
      case 'completed': return t('voice.live.completed', { defaultValue: '전송 완료' });
      case 'interrupted': return t('voice.live.interrupted', { defaultValue: '중단됨' });
    }
  };
  return (
    <section aria-label={t('voice.live.title', { defaultValue: '실시간 음성 자막' })}
      className="mt-3 min-w-0 border-t border-[var(--th-border-subtle)] pt-3 text-sm leading-relaxed [overflow-wrap:anywhere] [word-break:keep-all]">
      <div className="max-h-64 space-y-3 overflow-y-auto overscroll-contain" tabIndex={0}
        aria-label={t('voice.live.scroll', { defaultValue: '음성 자막 내용' })}>
        <div>
          <div className="mb-1 text-xs font-medium text-[var(--th-text-muted)]">
            {t('voice.live.input', { defaultValue: '내가 하는 말' })}
            {transcript.input && !transcript.input.final && <span> · {t('voice.live.interim', { defaultValue: '인식 중' })}</span>}
          </div>
          <p aria-live="off" className={transcript.input?.final ? 'text-[var(--th-text-primary)]' : 'text-[var(--th-text-muted)]'}>
            {transcript.input?.text || t('voice.live.empty', { defaultValue: '말씀하시면 여기에 표시됩니다.' })}
          </p>
        </div>
        {transcript.sentences.length > 0 && <div>
          <div className="mb-1 text-xs font-medium text-[var(--th-text-muted)]">{t('voice.live.answer', { defaultValue: 'AI 답변' })}</div>
          <ol className="space-y-2" aria-live="off">
            {transcript.sentences.map((sentence) => {
              const highlighted = sentence.state === 'speaking' && audioPlaying;
              return <li key={`${sentence.turnId}:${sentence.revision}:${sentence.speechId}`}
                data-voice-sentence-state={sentence.state} data-voice-highlighted={highlighted ? 'true' : 'false'}
                className={highlighted ? 'font-semibold text-[var(--th-text-primary)]' : 'text-[var(--th-text-secondary)]'}>
                <p>{sentence.text}</p>
                <span className="text-xs font-normal text-[var(--th-text-muted)]">{label(sentence.state)}</span>
              </li>;
            })}
          </ol>
        </div>}
        {transcript.waiting && <p className="text-[var(--th-text-secondary)]">{t('voice.live.waiting', { defaultValue: '답변을 준비하고 있습니다.' })}</p>}
      </div>
      <p className="mt-3 text-xs text-[var(--th-text-muted)]">
        {t('voice.live.timingHint', { defaultValue: '문장 위치는 음성 전송 기준으로 표시됩니다.' })}
      </p>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {transcript.input?.final ? `${t('voice.live.confirmed', { defaultValue: '입력 확정' })}: ${transcript.input.text}` : ''}
      </span>
    </section>
  );
}
