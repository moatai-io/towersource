import { describe, it, expect } from 'vitest';
import {
  detectContextReference,
  buildTier1Summary,
  buildTier2Detail,
  assembleRoomContext,
  truncateToTokenBudget,
  filterExpiredContexts,
  type AiContextEntry,
  type RoomContextConfig,
} from './room-context';

// ── Context Reference Detection ───────────────────────────────────

describe('detectContextReference', () => {
  it('detects "이 중에서" as referencing previous task', () => {
    expect(detectContextReference('이 중에서 3개월 내 리밸런싱 안 한 고객만').hasReference).toBe(true);
  });

  it('detects "위 결과" pattern', () => {
    expect(detectContextReference('위 결과에서 VVIP만 필터링해줘').hasReference).toBe(true);
  });

  it('detects "아까" pattern', () => {
    expect(detectContextReference('아까 뽑은 목록에서 상위 10개만').hasReference).toBe(true);
  });

  it('detects "from the above" in English', () => {
    expect(detectContextReference('from the above results, filter only VVIPs').hasReference).toBe(true);
  });

  it('detects "those results" pattern', () => {
    expect(detectContextReference('among those results, show top 10').hasReference).toBe(true);
  });

  it('detects "previous" / "이전" pattern', () => {
    expect(detectContextReference('이전 분석 결과 기반으로').hasReference).toBe(true);
    expect(detectContextReference('based on the previous analysis').hasReference).toBe(true);
  });

  it('returns false for standalone questions', () => {
    expect(detectContextReference('삼성전자 노출 고객 뽑아줘').hasReference).toBe(false);
    expect(detectContextReference('오늘 날씨 어때?').hasReference).toBe(false);
    expect(detectContextReference('ETF 리밸런싱 대상 분석해줘').hasReference).toBe(false);
  });
});

// ── Tier 1 Summary Building ───────────────────────────────────────

describe('buildTier1Summary', () => {
  const entries: AiContextEntry[] = [
    {
      taskId: 't-247',
      question: '삼성전자 노출 고객',
      answerSummary: '1,240명, 총 890억, VVIP 3명',
      tokenCount: 80,
      createdAt: '2026-03-11T10:00:00Z',
    },
    {
      taskId: 't-245',
      question: 'ETF 리밸런싱 대상',
      answerSummary: '대상 152건, 총 잔고 1,200억',
      tokenCount: 60,
      createdAt: '2026-03-11T08:00:00Z',
    },
    {
      taskId: 't-241',
      question: '신규 가입 고객 통계',
      answerSummary: '이번 달 47명, 전월 대비 +12%',
      tokenCount: 50,
      createdAt: '2026-03-10T15:00:00Z',
    },
    {
      taskId: 't-240',
      question: '오래된 태스크',
      answerSummary: '더미 데이터',
      tokenCount: 40,
      createdAt: '2026-03-09T10:00:00Z',
    },
  ];

  it('returns most recent N entries', () => {
    const result = buildTier1Summary(entries, 3);
    expect(result).toHaveLength(3);
    expect(result[0].taskId).toBe('t-247');
    expect(result[2].taskId).toBe('t-241');
  });

  it('returns all entries if fewer than limit', () => {
    const result = buildTier1Summary(entries.slice(0, 2), 5);
    expect(result).toHaveLength(2);
  });

  it('returns empty array for no entries', () => {
    expect(buildTier1Summary([], 3)).toHaveLength(0);
  });

  it('entries are ordered most-recent first', () => {
    const result = buildTier1Summary(entries, 4);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].createdAt >= result[i].createdAt).toBe(true);
    }
  });
});

// ── Tier 2 Detail Building ────────────────────────────────────────

describe('buildTier2Detail', () => {
  const entries: AiContextEntry[] = [
    {
      taskId: 't-247',
      question: '삼성전자 노출 고객',
      answerSummary: '1,240명',
      tokenCount: 80,
      createdAt: '2026-03-11T10:00:00Z',
      sql: 'SELECT * FROM customers WHERE exposure > 0',
      sampleRows: [['홍길동', 50000000, 'VVIP']],
      schema: ['name:text', 'exposure:numeric', 'grade:text'],
      rowCount: 1240,
    },
  ];

  it('returns detail for referenced task', () => {
    const result = buildTier2Detail(entries, 't-247');
    expect(result).not.toBeNull();
    expect(result!.taskId).toBe('t-247');
    expect(result!.sql).toBeDefined();
    expect(result!.sampleRows).toBeDefined();
  });

  it('returns null for non-existent task', () => {
    expect(buildTier2Detail(entries, 't-999')).toBeNull();
  });

  it('returns most recent entry when no specific task referenced', () => {
    const result = buildTier2Detail(entries, undefined);
    expect(result).not.toBeNull();
    expect(result!.taskId).toBe('t-247');
  });
});

// ── Token Budget ──────────────────────────────────────────────────

describe('truncateToTokenBudget', () => {
  const entries: AiContextEntry[] = [
    { taskId: 't1', question: 'q1', answerSummary: 's1', tokenCount: 500, createdAt: '2026-03-11T10:00:00Z' },
    { taskId: 't2', question: 'q2', answerSummary: 's2', tokenCount: 500, createdAt: '2026-03-11T09:00:00Z' },
    { taskId: 't3', question: 'q3', answerSummary: 's3', tokenCount: 500, createdAt: '2026-03-11T08:00:00Z' },
    { taskId: 't4', question: 'q4', answerSummary: 's4', tokenCount: 500, createdAt: '2026-03-11T07:00:00Z' },
  ];

  it('includes all entries within budget', () => {
    const result = truncateToTokenBudget(entries, 2000);
    expect(result).toHaveLength(4);
  });

  it('truncates to fit budget (most recent first)', () => {
    const result = truncateToTokenBudget(entries, 1200);
    expect(result).toHaveLength(2);
    expect(result[0].taskId).toBe('t1'); // most recent kept
    expect(result[1].taskId).toBe('t2');
  });

  it('returns empty for zero budget', () => {
    expect(truncateToTokenBudget(entries, 0)).toHaveLength(0);
  });

  it('returns at least one entry if budget allows', () => {
    const result = truncateToTokenBudget(entries, 500);
    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe('t1');
  });
});

// ── Expiry Filter ─────────────────────────────────────────────────

describe('filterExpiredContexts', () => {
  it('removes expired entries', () => {
    const now = new Date('2026-03-11T12:00:00Z').getTime();
    const entries: AiContextEntry[] = [
      { taskId: 't1', question: 'q', answerSummary: 's', tokenCount: 100, createdAt: '2026-03-11T10:00:00Z', expiresAt: '2026-03-11T11:00:00Z' },  // expired
      { taskId: 't2', question: 'q', answerSummary: 's', tokenCount: 100, createdAt: '2026-03-11T10:00:00Z', expiresAt: '2026-03-11T13:00:00Z' },  // not expired
      { taskId: 't3', question: 'q', answerSummary: 's', tokenCount: 100, createdAt: '2026-03-11T10:00:00Z' },  // no expiry (pinned)
    ];

    const result = filterExpiredContexts(entries, now);
    expect(result).toHaveLength(2);
    expect(result.map(e => e.taskId)).toEqual(['t2', 't3']);
  });

  it('keeps all entries when none expired', () => {
    const now = new Date('2026-03-11T10:30:00Z').getTime();
    const entries: AiContextEntry[] = [
      { taskId: 't1', question: 'q', answerSummary: 's', tokenCount: 100, createdAt: '2026-03-11T10:00:00Z', expiresAt: '2026-03-11T22:00:00Z' },
    ];
    expect(filterExpiredContexts(entries, now)).toHaveLength(1);
  });
});

// ── Full Context Assembly ─────────────────────────────────────────

describe('assembleRoomContext', () => {
  const defaultConfig: RoomContextConfig = {
    maxTier1Count: 3,
    maxTier1Tokens: 1500,
    maxTier2Tokens: 2000,
    maxRecentMessages: 10,
    maxTotalTokens: 5000,
  };

  it('returns empty context for room with no history', () => {
    const result = assembleRoomContext({
      roomName: '리서치팀',
      roomDescription: 'AI 분석 채팅방',
      aiContextEntries: [],
      recentMessages: [],
      userPrompt: '삼성전자 분석해줘',
      config: defaultConfig,
    });

    expect(result).toContain('리서치팀');
    expect(result).toContain('삼성전자 분석해줘');
    // No tier content when no entries
    expect(result).not.toContain('이전 태스크 요약');
  });

  it('builds background-only context without duplicating the current question', async () => {
    const { assembleRoomBackgroundContext } = await import('./room-context.js');
    const result = assembleRoomBackgroundContext({
      roomName: '리서치팀',
      roomDescription: 'AI 분석 채팅방',
      aiContextEntries: [],
      recentMessages: [],
      userPrompt: '삼성전자 분석해줘',
      config: defaultConfig,
    });

    expect(result).toContain('리서치팀');
    expect(result).not.toContain('[질문]');
    expect(result).not.toContain('삼성전자 분석해줘');
  });

  it('includes Tier 1 summaries when history exists', () => {
    const result = assembleRoomContext({
      roomName: '리서치팀',
      roomDescription: '',
      aiContextEntries: [
        { taskId: 't-247', question: '삼성전자 노출 고객', answerSummary: '1,240명', tokenCount: 80, createdAt: '2026-03-11T10:00:00Z' },
      ],
      recentMessages: [],
      userPrompt: '이 중에서 VVIP만',
      config: defaultConfig,
    });

    expect(result).toContain('t-247');
    expect(result).toContain('삼성전자 노출 고객');
    expect(result).toContain('1,240명');
  });

  it('includes Tier 2 when reference detected', () => {
    const result = assembleRoomContext({
      roomName: '리서치팀',
      roomDescription: '',
      aiContextEntries: [
        {
          taskId: 't-247',
          question: '삼성전자 노출 고객',
          answerSummary: '1,240명',
          tokenCount: 200,
          createdAt: '2026-03-11T10:00:00Z',
          sql: 'SELECT * FROM customers',
          sampleRows: [['홍길동', 50000000]],
          schema: ['name:text', 'exposure:numeric'],
          rowCount: 1240,
        },
      ],
      recentMessages: [],
      userPrompt: '이 중에서 VVIP만 뽑아줘',
      config: defaultConfig,
    });

    expect(result).toContain('SELECT * FROM customers');
    expect(result).toContain('홍길동');
  });

  it('does NOT include Tier 2 for standalone questions', () => {
    const result = assembleRoomContext({
      roomName: '리서치팀',
      roomDescription: '',
      aiContextEntries: [
        {
          taskId: 't-247',
          question: '삼성전자 노출 고객',
          answerSummary: '1,240명',
          tokenCount: 200,
          createdAt: '2026-03-11T10:00:00Z',
          sql: 'SELECT * FROM customers',
          sampleRows: [['홍길동', 50000000]],
          schema: ['name:text', 'exposure:numeric'],
          rowCount: 1240,
        },
      ],
      recentMessages: [],
      userPrompt: 'LG전자 노출 고객 분석해줘',
      config: defaultConfig,
    });

    // Tier 1 summary should be there
    expect(result).toContain('t-247');
    // But Tier 2 SQL should NOT be there (no reference to previous)
    expect(result).not.toContain('SELECT * FROM customers');
  });

  it('includes recent messages as conversation context', () => {
    const result = assembleRoomContext({
      roomName: '리서치팀',
      roomDescription: '',
      aiContextEntries: [],
      recentMessages: [
        { sender: '김PB', content: '@ai 삼성전자 노출 고객 뽑아줘', timestamp: '10:00' },
        { sender: 'AI', content: '완료. 1,240명, 890억', timestamp: '10:01' },
        { sender: '박부장', content: '@ai 이 중에 리밸런싱 안 한 고객만', timestamp: '10:05' },
      ],
      userPrompt: '이 중에 리밸런싱 안 한 고객만',
      config: defaultConfig,
    });

    expect(result).toContain('김PB');
    expect(result).toContain('박부장');
  });
});
