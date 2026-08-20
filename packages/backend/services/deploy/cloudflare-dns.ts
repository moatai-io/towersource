/**
 * Cloudflare DNS Manager — 고객별 서브도메인 자동 설정
 *
 * Phase 4 핵심 서비스. 새 고객 온보딩 시:
 *   1. createWildcardForCustomer() → *.customer.tower.example.com 와일드카드 DNS 생성
 *   2. 자체 호스팅 서버에 nginx 와일드카드 서버 블록 + certbot 와일드카드 SSL
 *   3. 이후 사이트 publish → sites/my-site/ 폴더만 생성하면 바로 접근 가능
 *
 * DNS 관리는 Moat AI 서버(TOWER_ROLE=full)에서만 실행.
 * 자체 호스팅 서버에서는 실행되지 않음.
 */

const CF_API = 'https://api.cloudflare.com/client/v4';

// ── Config ──

function getCfConfig() {
  // DNS token = same as API token (Pages + DNS Edit + Zone Read)
  const token = process.env.CLOUDFLARE_DNS_TOKEN || process.env.CLOUDFLARE_API_TOKEN || '';
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  let publicHost = '';
  try {
    publicHost = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).hostname : '';
  } catch {}
  const parentDomain = (process.env.CLOUDFLARE_PARENT_DOMAIN || publicHost).trim().replace(/^\.+|\.+$/g, '');
  if (!parentDomain) {
    throw new Error('CLOUDFLARE_PARENT_DOMAIN or PUBLIC_URL is required for managed DNS operations');
  }
  return { token, accountId, parentDomain };
}

function getParentDomain(): string {
  return getCfConfig().parentDomain;
}

function cfHeaders(): Record<string, string> {
  return {
    'Authorization': `Bearer ${getCfConfig().token}`,
    'Content-Type': 'application/json',
  };
}

// ── Types ──

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  comment?: string;
  created_on: string;
  modified_on: string;
}

export interface CustomerDnsSetup {
  customer: string;
  ip: string;
  wildcardRecord?: DnsRecord;
  baseRecord?: DnsRecord;
  status: 'ready' | 'partial' | 'missing';
}

// ── Zone Management ──

let _zoneIdCache = '';

/**
 * Get the Cloudflare Zone ID for tower.example.com.
 * Cached after first call.
 */
export async function getZoneId(): Promise<string> {
  if (_zoneIdCache) return _zoneIdCache;

  const res = await fetch(`${CF_API}/zones?name=${getParentDomain()}`, { headers: cfHeaders() });
  const data = await res.json() as any;

  if (!data.success || !data.result?.length) {
    throw new Error(`Zone '${getParentDomain()}' not found. Check CF token has Zone Read permission.`);
  }

  _zoneIdCache = data.result[0].id;
  return _zoneIdCache;
}

// ── DNS Record CRUD ──

/**
 * List all DNS records matching a name pattern.
 */
export async function listDnsRecords(nameFilter?: string): Promise<DnsRecord[]> {
  const zoneId = await getZoneId();
  const params = new URLSearchParams({ per_page: '100' });
  if (nameFilter) params.set('name', nameFilter);

  const res = await fetch(`${CF_API}/zones/${zoneId}/dns_records?${params}`, { headers: cfHeaders() });
  const data = await res.json() as any;

  if (!data.success) throw new Error(`Failed to list DNS records: ${JSON.stringify(data.errors)}`);
  return data.result || [];
}

/**
 * Create a DNS record.
 */
export async function createDnsRecord(opts: {
  type: 'A' | 'AAAA' | 'CNAME';
  name: string;
  content: string;
  proxied?: boolean;
  comment?: string;
}): Promise<DnsRecord> {
  const zoneId = await getZoneId();

  const res = await fetch(`${CF_API}/zones/${zoneId}/dns_records`, {
    method: 'POST',
    headers: cfHeaders(),
    body: JSON.stringify({
      type: opts.type,
      name: opts.name,
      content: opts.content,
      ttl: 1, // auto
      proxied: opts.proxied ?? false,
      comment: opts.comment || '',
    }),
  });

  const data = await res.json() as any;
  if (!data.success) {
    // Check if record already exists
    if (data.errors?.some((e: any) => e.message?.includes('already exists'))) {
      console.log(`[cf-dns] Record already exists: ${opts.name}`);
      const existing = await listDnsRecords(opts.name);
      if (existing.length) return existing[0];
    }
    throw new Error(`Failed to create DNS record: ${JSON.stringify(data.errors)}`);
  }

  console.log(`[cf-dns] Created: ${opts.type} ${opts.name} → ${opts.content}`);
  return data.result;
}

/**
 * Delete a DNS record by ID.
 */
export async function deleteDnsRecord(recordId: string): Promise<void> {
  const zoneId = await getZoneId();
  const res = await fetch(`${CF_API}/zones/${zoneId}/dns_records/${recordId}`, {
    method: 'DELETE',
    headers: cfHeaders(),
  });
  const data = await res.json() as any;
  if (!data.success) throw new Error(`Failed to delete DNS record: ${JSON.stringify(data.errors)}`);
  console.log(`[cf-dns] Deleted record: ${recordId}`);
}

// ── Customer Domain Setup ──

/**
 * Create wildcard DNS for a customer.
 * Creates: *.customer.tower.example.com → customer's VM IP
 *
 * This is Step 1 of customer domain setup. After this:
 *   - Step 2: SSH to VM → nginx wildcard server block
 *   - Step 3: SSH to VM → certbot wildcard SSL
 *
 * @example
 *   await createWildcardForCustomer('demo-org', '203.0.113.10');
 *   // Creates: *.demo-org.tower.example.com → 203.0.113.10
 */
export async function createWildcardForCustomer(
  customerName: string,
  vmIp: string,
): Promise<{ wildcard: DnsRecord; status: string }> {
  // Validate
  if (!/^[a-z0-9][a-z0-9-]*$/.test(customerName)) {
    throw new Error('Customer name must be lowercase alphanumeric with hyphens');
  }

  // Check if wildcard already exists
  const existing = await listDnsRecords(`*.${customerName}.${getParentDomain()}`);
  if (existing.length) {
    console.log(`[cf-dns] Wildcard already exists for ${customerName}: ${existing[0].content}`);
    if (existing[0].content !== vmIp) {
      console.warn(`[cf-dns] ⚠️ IP mismatch! Record: ${existing[0].content}, Expected: ${vmIp}`);
    }
    return { wildcard: existing[0], status: 'already_exists' };
  }

  // Create wildcard A record (not proxied — customer uses own certbot SSL)
  const wildcard = await createDnsRecord({
    type: 'A',
    name: `*.${customerName}.${getParentDomain()}`,
    content: vmIp,
    proxied: false,
    comment: `Wildcard for ${customerName} published sites`,
  });

  return { wildcard, status: 'created' };
}

/**
 * Check the DNS setup status for a customer.
 */
export async function getCustomerDnsStatus(customerName: string): Promise<CustomerDnsSetup> {
  const wildcardName = `*.${customerName}.${getParentDomain()}`;
  const baseName = `${customerName}.${getParentDomain()}`;

  const [wildcardRecords, baseRecords] = await Promise.all([
    listDnsRecords(wildcardName),
    listDnsRecords(baseName),
  ]);

  const wildcardRecord = wildcardRecords[0];
  const baseRecord = baseRecords[0];

  let status: CustomerDnsSetup['status'] = 'missing';
  if (wildcardRecord && baseRecord) status = 'ready';
  else if (wildcardRecord || baseRecord) status = 'partial';

  return {
    customer: customerName,
    ip: wildcardRecord?.content || baseRecord?.content || '',
    wildcardRecord,
    baseRecord,
    status,
  };
}

/**
 * Remove all DNS records for a customer (cleanup on deactivation).
 */
export async function removeCustomerDns(customerName: string): Promise<{ removed: number }> {
  const wildcardName = `*.${customerName}.${getParentDomain()}`;
  const records = await listDnsRecords(wildcardName);

  for (const r of records) {
    await deleteDnsRecord(r.id);
  }

  console.log(`[cf-dns] Removed ${records.length} DNS records for ${customerName}`);
  return { removed: records.length };
}

/**
 * List all customer wildcard DNS records.
 * Returns only *.xxx.tower.example.com pattern records.
 */
export async function listCustomerWildcards(): Promise<Array<{
  customer: string;
  ip: string;
  record: DnsRecord;
}>> {
  const allRecords = await listDnsRecords();
  const wildcardPattern = new RegExp(`^\\*\\.([a-z0-9-]+)\\.${getParentDomain().replace('.', '\\.')}$`);

  return allRecords
    .filter(r => wildcardPattern.test(r.name))
    .map(r => {
      const match = r.name.match(wildcardPattern)!;
      return {
        customer: match[1],
        ip: r.content,
        record: r,
      };
    });
}

// ── Cloudflare Pages Custom Domain ──

/**
 * Add a custom domain to a Cloudflare Pages project.
 * Used when deploying via Gateway — maps customer subdomain to Pages project.
 *
 * @example
 *   await addPagesDomain('demo-org--my-report', 'my-report.demo-org.tower.example.com');
 */
export async function addPagesDomain(projectName: string, domain: string): Promise<{ success: boolean; error?: string }> {
  const { accountId } = getCfConfig();
  if (!accountId) return { success: false, error: 'CLOUDFLARE_ACCOUNT_ID not set' };

  const res = await fetch(
    `${CF_API}/accounts/${accountId}/pages/projects/${projectName}/domains`,
    {
      method: 'POST',
      headers: cfHeaders(),
      body: JSON.stringify({ name: domain }),
    },
  );

  const data = await res.json() as any;
  if (!data.success) {
    const errMsg = data.errors?.map((e: any) => e.message).join(', ') || 'Unknown error';
    console.warn(`[cf-dns] Pages domain failed: ${errMsg}`);
    return { success: false, error: errMsg };
  }

  console.log(`[cf-dns] Pages domain added: ${domain} → ${projectName}`);
  return { success: true };
}
