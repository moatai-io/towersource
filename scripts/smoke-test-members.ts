#!/usr/bin/env tsx
/**
 * smoke-test-members.ts — 멤버 추가 / 본인 비번 변경 / username 변경의 6 시나리오 검증.
 *
 * 사용: npx tsx scripts/smoke-test-members.ts
 *
 * Dev backend 가 :32355 에서 떠 있어야 함. 실 DB 에 임시 사용자 (smoke-<timestamp>) 를
 * 만들고 시나리오 후 자동 disabled. cleanup 실패 시 admin 패널에서 수동 삭제 가능.
 *
 * 결정: workspace/decisions/2026-05-20-members-name-affiliation-and-credentials.md
 */

import { initPg } from '../packages/backend/db/pg.js';
import { queryOne, execute } from '../packages/backend/db/pg-repo.js';
import {
  createUser, authenticateUser, generateToken, verifyToken,
  changeOwnPassword, updateUserUsername, updateUserProfile,
  getOwnProfile, listUsers, UsernameTakenError, InvalidUsernameError,
} from '../packages/backend/services/auth/auth.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TIMESTAMP = Date.now();
const TEST_USERNAME = `smoke-${TIMESTAMP}`;
const TEST_PASSWORD_1 = 'smoketest12345';
const TEST_PASSWORD_2 = 'newsmoketest6789';
const RENAMED_USERNAME = `smoke-renamed-${TIMESTAMP}`;

function assert(cond: any, msg: string) {
  if (!cond) {
    console.error(`❌ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`✅ ${msg}`);
}

async function main() {
  await initPg();
  console.log(`\n=== Smoke test start (username=${TEST_USERNAME}) ===\n`);

  // ── 시나리오 1: createUser with displayName/affiliation ──
  const created = await createUser(TEST_USERNAME, TEST_PASSWORD_1, 'member', {
    displayName: 'Smoke Tester',
    affiliation: 'Tower QA',
  });
  assert(created.id > 0, `createUser returned id=${created.id}`);

  const fresh = await listUsers();
  const row = fresh.find((u) => u.id === created.id);
  assert(row?.display_name === 'Smoke Tester', 'display_name persisted');
  assert(row?.affiliation === 'Tower QA', 'affiliation persisted');

  // ── 시나리오 2: authenticateUser + token issue ──
  const auth = await authenticateUser(TEST_USERNAME, TEST_PASSWORD_1);
  assert(auth !== null, 'authenticateUser returned payload');
  const oldToken = generateToken(auth!);
  const decoded = verifyToken(oldToken);
  assert(decoded?.username === TEST_USERNAME, 'JWT has correct username');

  // ── 시나리오 3: getOwnProfile ──
  const profile = await getOwnProfile(created.id);
  assert(profile?.display_name === 'Smoke Tester', 'getOwnProfile display_name');

  // ── 시나리오 4: updateUserProfile (본인 편집) ──
  await updateUserProfile(created.id, { affiliation: 'Tower QA → Moved' });
  const profile2 = await getOwnProfile(created.id);
  assert(profile2?.affiliation === 'Tower QA → Moved', 'updateUserProfile reflected');

  // 빈 문자열 → NULL 변환 검증
  await updateUserProfile(created.id, { affiliation: '' });
  const profile3 = await getOwnProfile(created.id);
  assert(profile3?.affiliation === null, "affiliation '' → NULL");
  await updateUserProfile(created.id, { affiliation: 'Tower QA' }); // 복원

  // ── 시나리오 5: changeOwnPassword + token invalidation ──
  const before = await queryOne<{ password_changed_at: string }>(
    'SELECT password_changed_at FROM users WHERE id = $1', [created.id]
  );
  await new Promise((r) => setTimeout(r, 1100)); // ensure timestamp differs by >1s

  const okBadPw = await changeOwnPassword(created.id, 'wrongpassword', TEST_PASSWORD_2);
  assert(okBadPw === false, 'changeOwnPassword rejects wrong old password');

  const okGoodPw = await changeOwnPassword(created.id, TEST_PASSWORD_1, TEST_PASSWORD_2);
  assert(okGoodPw === true, 'changeOwnPassword succeeds with correct old password');

  const after = await queryOne<{ password_changed_at: string }>(
    'SELECT password_changed_at FROM users WHERE id = $1', [created.id]
  );
  assert(
    new Date(after!.password_changed_at) > new Date(before!.password_changed_at),
    'password_changed_at bumped on changeOwnPassword'
  );

  // 옛 토큰의 iat 가 password_changed_at 보다 이전인지 확인
  const oldIat = (decoded as any).iat * 1000;
  const pcaMs = new Date(after!.password_changed_at).getTime();
  assert(pcaMs > oldIat, 'old token iat is older than new password_changed_at (would be rejected)');

  // 새 토큰으로 재로그인
  const auth2 = await authenticateUser(TEST_USERNAME, TEST_PASSWORD_2);
  assert(auth2 !== null, 're-login with new password works');

  // ── 시나리오 6: updateUserUsername + people/<u>.md rename ──
  // 우선 people/<old>.md 한번 만들어둠 (rename 검증용)
  const peopleDir = path.join(os.homedir(), 'workspace', 'projects', '_team', 'people');
  const oldPeopleFile = path.join(peopleDir, `${TEST_USERNAME}.md`);
  const newPeopleFile = path.join(peopleDir, `${RENAMED_USERNAME}.md`);
  fs.mkdirSync(peopleDir, { recursive: true });
  fs.writeFileSync(oldPeopleFile, `# ${TEST_USERNAME}\n\nTest profile for smoke test.\n`);
  assert(fs.existsSync(oldPeopleFile), 'old people/.md exists pre-rename');

  await updateUserUsername(created.id, RENAMED_USERNAME, null, { reason: 'smoke test' });

  const renamed = await queryOne<{ username: string }>(
    'SELECT username FROM users WHERE id = $1', [created.id]
  );
  assert(renamed?.username === RENAMED_USERNAME, 'DB username updated');

  const histRow = await queryOne<any>(
    'SELECT old_username, new_username, reason FROM user_username_history WHERE user_id = $1',
    [created.id]
  );
  assert(histRow?.old_username === TEST_USERNAME, 'history row has old_username');
  assert(histRow?.new_username === RENAMED_USERNAME, 'history row has new_username');
  assert(histRow?.reason === 'smoke test', 'history row has reason');

  assert(!fs.existsSync(oldPeopleFile), 'old people/.md no longer exists');
  assert(fs.existsSync(newPeopleFile), 'new people/.md exists');

  // ── 시나리오 7: InvalidUsernameError / UsernameTakenError ──
  let invalidThrown = false;
  try {
    await updateUserUsername(created.id, 'BadUsername!!', null);
  } catch (e: any) {
    invalidThrown = e instanceof InvalidUsernameError;
  }
  assert(invalidThrown, 'InvalidUsernameError for uppercase/special chars');

  let takenThrown = false;
  try {
    await updateUserUsername(created.id, 'admin', null); // already taken
  } catch (e: any) {
    takenThrown = e instanceof UsernameTakenError;
  }
  assert(takenThrown, 'UsernameTakenError for existing username');

  // ── Cleanup ──
  fs.unlinkSync(newPeopleFile);
  await execute('UPDATE users SET disabled = 1 WHERE id = $1', [created.id]);
  console.log(`\n=== Cleanup: user ${created.id} disabled, people/.md deleted ===`);

  console.log('\n🎉 All 7 scenarios passed.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
