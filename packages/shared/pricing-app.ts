/** Host-owned pricing.v1: no code, URL or executable expression inputs. */
export interface PricingValues { customers: number; price: number; discount: number; fixed: number; variable: number }
export interface PricingDeclaration { schemaVersion: 1; template: 'pricing.v1'; title?: string; initialValues: PricingValues }
const keys = ['customers', 'price', 'discount', 'fixed', 'variable'] as const;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function parsePricingValues(value: unknown): PricingValues {
  if (!record(value) || Object.keys(value).length !== keys.length || !keys.every(k => Object.hasOwn(value, k))) throw new Error('가격 입력 필드를 확인하세요.');
  for (const key of keys) {
    const v = value[key]; const max = key === 'discount' ? 100 : key === 'customers' ? 1_000_000 : 1_000_000_000;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max || !Number.isInteger(v)) throw new Error('입력은 허용 범위의 정수여야 합니다.');
  }
  return Object.fromEntries(keys.map(k => [k,value[k]])) as unknown as PricingValues;
}
export function parsePricingDeclaration(value: unknown): PricingDeclaration {
  if (!record(value) || Object.keys(value).some(k => !['schemaVersion','template','title','initialValues'].includes(k)) || value.schemaVersion !== 1 || value.template !== 'pricing.v1') throw new Error('지원하지 않는 화면 선언입니다.');
  if (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 120)) throw new Error('제목은 120자 이하의 텍스트여야 합니다.');
  return { schemaVersion: 1, template: 'pricing.v1', ...(value.title !== undefined ? { title: value.title as string } : {}), initialValues: parsePricingValues(value.initialValues) };
}
export function calculatePricing(input: PricingValues) {
  const x = parsePricingValues(input);
  // BigInt hundredths of KRW: integer inputs and integer percentage discounts.
  const unit = BigInt(x.price) * BigInt(100 - x.discount);
  const revenue = BigInt(x.customers) * unit;
  const cost = (BigInt(x.fixed) + BigInt(x.customers) * BigInt(x.variable)) * 100n;
  const margin = unit - BigInt(x.variable) * 100n;
  const rounded = (n: bigint) => Number(n < 0n ? -((-n + 50n) / 100n) : (n + 50n) / 100n);
  return { revenue: rounded(revenue), cost: rounded(cost), contribution: rounded(revenue-cost), breakEvenCustomers: margin > 0n ? Number((BigInt(x.fixed)*100n+margin-1n)/margin) : null };
}
