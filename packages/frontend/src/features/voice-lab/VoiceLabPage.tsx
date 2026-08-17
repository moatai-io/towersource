/** Owns: Dev-only isolated surface for testing Tower's LiveKit voice loop. */
import { useMemo, useState } from 'react';
import { VoiceConversationButton } from '../../components/chat/VoiceConversationButton';

const SESSION_KEY = 'tower:voice-lab:session-id';
const DEV_DEFAULT_SESSION_ID = '171dc31d-5c7c-41f9-b457-a492428a93da';
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Render an isolated voice test bench without the normal Tower chat shell. */
export function VoiceLabPage() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [sessionId, setSessionId] = useState(() => params.get('sessionId') || localStorage.getItem(SESSION_KEY) || DEV_DEFAULT_SESSION_ID);
  const [inferenceTtsProvider, setInferenceTtsProvider] = useState<'cartesia' | 'inworld'>('cartesia');
  const normalizedSessionId = sessionId.trim();
  const validSessionId = SESSION_ID_RE.test(normalizedSessionId);
  const devHost = import.meta.env.DEV || ['desk-dev.tower.example.com', 'app.localhost'].includes(window.location.hostname);

  if (!devHost) {
    return <main className="flex min-h-screen items-center justify-center bg-surface-950 p-6 text-surface-100">Voice Lab은 Dev에서만 사용할 수 있습니다.</main>;
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-950 p-5 text-surface-100">
      <section className="w-full max-w-xl border-y border-surface-700 py-10">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-300">Tower Dev · Voice Lab</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">음성 왕복만 테스트합니다</h1>
        <p className="mt-3 max-w-lg text-sm leading-6 text-surface-300">
          Tower Development의 Session UUID를 넣고 연결하세요. 마이크 입력, LiveKit STT, AI 응답, 스피커 재생 상태만 확인합니다.
        </p>

        <label className="mt-8 block text-sm font-medium text-surface-200" htmlFor="voice-lab-session">Session UUID</label>
        <input
          id="voice-lab-session"
          value={sessionId}
          onChange={(event) => {
            const value = event.target.value;
            setSessionId(value);
            if (SESSION_ID_RE.test(value.trim())) localStorage.setItem(SESSION_KEY, value.trim());
          }}
          placeholder="171dc31d-5c7c-41f9-b457-a492428a93da"
          spellCheck={false}
          className="mt-2 w-full rounded-lg border border-surface-600 bg-surface-900 px-3 py-2.5 font-mono text-sm text-surface-100 outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-400/20"
        />
        <p className={`mt-2 text-xs ${normalizedSessionId && !validSessionId ? 'text-red-300' : 'text-surface-500'}`}>
          {normalizedSessionId && !validSessionId ? '올바른 Session UUID를 입력해 주세요.' : '같은 Project의 기존 Tower Session을 사용합니다.'}
        </p>

        <fieldset className="mt-6">
          <legend className="text-sm font-medium text-surface-200">응답 음성</legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {([
              ['cartesia', '안정 기본 음성'],
              ['inworld', 'Seojun'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setInferenceTtsProvider(value)}
                className={`min-h-12 touch-manipulation rounded-lg border px-3 text-sm font-medium ${
                  inferenceTtsProvider === value
                    ? 'border-primary-400 bg-primary-500/15 text-primary-100'
                    : 'border-surface-600 bg-surface-900 text-surface-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="mt-6 flex min-h-28 items-center justify-center border-y border-surface-800 py-8">
          <VoiceConversationButton
            sessionId={validSessionId ? normalizedSessionId : null}
            inferenceTtsProvider={inferenceTtsProvider}
          />
        </div>

        <div className="mt-6 grid grid-cols-3 gap-3 text-center text-xs text-surface-400">
          <span>1. 연결</span><span>2. 한국어로 말하기</span><span>3. AI 음성 확인</span>
        </div>
      </section>
    </main>
  );
}
