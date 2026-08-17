/**
 * customer-scope.ts — Owns: customer_manager 의 담당 self-hosted server scope 강제.
 * Public API: userCanAccessCustomer, userCanAccessCustomerName,
 * listAccessibleCustomers, listAccessibleCustomerNames.
 *
 * Single source of truth for "이 사용자가 이 customer 를 만질 수 있나" 결정.
 * - admin / operator → 모든 customer
 * - customer_manager → user_customer_vms 매핑된 customer 만
 * - 그 외 (member / guest / viewer) → none (self-hosted server 도구 자체 권한 없음)
 *
 * 사용처:
 * - fleet skill / fleet status API — 목록 필터 + 개별 조작 게이트
 * - customer-voice skill — 특정 customer listen 게이트
 * - SSH alias 접근 — alias 별 게이트
 *
 * 결정: workspace/decisions/2026-05-27-operator-host-privileged-roles-and-cross-project-relaxation.md §3-E
 *      workspace/decisions/2026-05-23-customer-manager-role.md
 */
import { queryOne, query } from '../../db/pg-repo.js';

/**
 * 이 사용자가 특정 self-hosted server 을 관리할 권한이 있는지.
 *
 * - admin / operator: 항상 true (모든 customer 관리)
 * - customer_manager: user_customer_vms 매핑이 있을 때만 true
 * - 그 외 role: 항상 false (self-hosted server 도구 자체 권한 없음)
 */
export async function userCanAccessCustomer(
  userId: number,
  role: string | null | undefined,
  customerId: string,
): Promise<boolean> {
  if (role === 'admin' || role === 'operator') return true;
  if (role !== 'customer_manager') return false;
  if (!userId || !customerId) return false;
  const row = await queryOne<{ ok: number }>(
    `SELECT 1 AS ok FROM user_customer_vms WHERE user_id = $1 AND customer_id = $2`,
    [userId, customerId],
  );
  return !!row;
}

/**
 * 이 사용자가 관리 가능한 customer 의 id 목록.
 *
 * - admin / operator: null 반환 (= unrestricted; 호출자가 전체 fleet 을 봐야 한다는 신호)
 * - customer_manager: user_customer_vms 에 매핑된 customer_id 배열 (없으면 빈 배열)
 * - 그 외 role: 빈 배열 (self-hosted server 도구 자체 권한 없음)
 *
 * 호출 예 (fleet list API):
 *   const ids = await listAccessibleCustomers(userId, role);
 *   if (ids === null) return allCustomers;
 *   return allCustomers.filter(c => ids.includes(c.id));
 */
export async function listAccessibleCustomers(
  userId: number,
  role: string | null | undefined,
): Promise<string[] | null> {
  if (role === 'admin' || role === 'operator') return null;
  if (role !== 'customer_manager') return [];
  if (!userId) return [];
  const rows = await query<{ customer_id: string }>(
    `SELECT customer_id FROM user_customer_vms WHERE user_id = $1 ORDER BY customer_id`,
    [userId],
  );
  return rows.map(r => r.customer_id);
}

/**
 * customer slug/name 기반 접근 확인. fleet-manager 는 library.yaml 의 customer
 * name(예: "demo-org")을 쓰고, user_customer_vms 는 gateway_customers.id(UUID)를
 * 저장하므로 여기서 join 해 양쪽 표현을 연결한다.
 */
export async function userCanAccessCustomerName(
  userId: number,
  role: string | null | undefined,
  customerName: string,
): Promise<boolean> {
  if (role === 'admin' || role === 'operator') return true;
  if (role !== 'customer_manager') return false;
  if (!userId || !customerName) return false;
  const row = await queryOne<{ ok: number }>(
    `SELECT 1 AS ok
       FROM user_customer_vms ucv
       JOIN gateway_customers c ON c.id = ucv.customer_id
      WHERE ucv.user_id = $1
        AND (c.customer_name = $2 OR c.id = $2)`,
    [userId, customerName],
  );
  return !!row;
}

/**
 * fleet 목록 필터용 customer name 목록.
 * admin/operator 는 null (= unrestricted), customer_manager 는 담당 slug 배열.
 */
export async function listAccessibleCustomerNames(
  userId: number,
  role: string | null | undefined,
): Promise<string[] | null> {
  if (role === 'admin' || role === 'operator') return null;
  if (role !== 'customer_manager') return [];
  if (!userId) return [];
  const rows = await query<{ customer_name: string }>(
    `SELECT c.customer_name
       FROM user_customer_vms ucv
       JOIN gateway_customers c ON c.id = ucv.customer_id
      WHERE ucv.user_id = $1
      ORDER BY c.customer_name`,
    [userId],
  );
  return rows.map(r => r.customer_name);
}
