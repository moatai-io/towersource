/**
 * Owns: 파일 뷰어 스크롤 위치 per-user × per-path 영구 저장 (localStorage).
 *
 * Public API:
 *   getScrollPos(path) → number | null   — 복원 시
 *   setScrollPos(path, top)              — 저장 (스로틀은 caller hook 책임)
 *
 * 키 정책: `tower:fileScroll:<username>` (username 은 JWT payload 에서, 추출
 * 실패 시 `__global` fallback). InputBox 의 getDraftKey 와 동일 패턴.
 *
 * 크기 가드: LRU 로 최대 CAP(=200) 항목 유지. 200개 넘으면 .at(마지막 접근
 * 시각) 기준 오래된 것부터 폐기. 평균 항목 크기 ~80 bytes → 최대 16KB 정도
 * 라 localStorage(5MB) 의 0.3% 미만. 안전.
 *
 * 의도적으로 안 하는 것:
 *   - 탭 id 기준 저장 — 탭 닫았다 다시 열면 잃어버림. path 기준이 본질.
 *   - 세션 간 동기화 — view 상태라 사용자 device 단위면 충분.
 *
 * 결정 근거: workspace/decisions/2026-05-22-global-multi-tab-shell.md (§ v3 후속)
 */
const PREFIX = 'tower:fileScroll:';
const CAP = 200;

function getKey(): string {
  try {
    const token = localStorage.getItem('token');
    if (token) {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.username) return PREFIX + payload.username;
    }
  } catch { /* fall through */ }
  return PREFIX + '__global';
}

type Entry = { top: number; at: number };
type ScrollMap = Record<string, Entry>;

function load(): ScrollMap {
  try {
    const raw = localStorage.getItem(getKey());
    if (raw) return JSON.parse(raw) as ScrollMap;
  } catch { /* corrupt → reset */ }
  return {};
}

function persist(map: ScrollMap): void {
  try {
    const entries = Object.entries(map);
    let next: ScrollMap = map;
    if (entries.length > CAP) {
      // LRU: drop oldest by .at
      entries.sort((a, b) => b[1].at - a[1].at);
      next = Object.fromEntries(entries.slice(0, CAP));
    }
    localStorage.setItem(getKey(), JSON.stringify(next));
  } catch { /* storage full → silent drop */ }
}

export function getScrollPos(path: string): number | null {
  const m = load();
  const e = m[path];
  if (!e) return null;
  // Touch .at on read so frequent-revisit paths survive LRU eviction.
  if (Date.now() - e.at > 60_000) {
    m[path] = { top: e.top, at: Date.now() };
    persist(m);
  }
  return e.top;
}

export function setScrollPos(path: string, top: number): void {
  if (!path || top < 0 || !Number.isFinite(top)) return;
  const m = load();
  m[path] = { top, at: Date.now() };
  persist(m);
}
