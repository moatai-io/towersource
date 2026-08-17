import type { WorkspaceAppDefinition } from './workspace-app-definition';

export const sampleWorkspaceAppDefinition: WorkspaceAppDefinition = {
  id: 'sales-ops',
  name: 'Sales Ops',
  eyebrow: '업무 앱 · Local metadata renderer',
  title: '업무 앱 연결 샘플',
  description: 'Frappe 같은 업무앱 backend를 붙이기 전, local metadata renderer로 업무 입력·조회·수정·출력 흐름을 확인하는 샘플입니다.',
  primaryActionLabel: '신규 등록',
  secondaryActionLabel: '관리자 설정',
  menuTitle: '업무 메뉴',
  menu: [
    { id: 'dashboard', label: '대시보드', live: true },
    { id: 'customers', label: '거래처' },
    { id: 'contracts', label: '계약' },
    { id: 'invoices', label: '청구' },
    { id: 'receivables', label: '미수금' },
    { id: 'settings', label: '설정' },
  ],
  metrics: [
    { id: 'monthly-invoice', label: '이번 달 청구', value: '₩42.8M', delta: '+18%', tone: 'primary' },
    { id: 'receivable', label: '미수금', value: '₩7.4M', delta: '3건 지연', tone: 'warn' },
    { id: 'renewals', label: '갱신 예정 계약', value: '12', delta: '30일 이내', tone: 'neutral' },
    { id: 'active-customers', label: '활성 거래처', value: '84', delta: '+6 이번 달', tone: 'success' },
  ],
  record: { id: 'customer', label: '고객사', table: 'accounts', primaryKey: 'id' },
  fields: [
    { id: 'name', label: '고객사', type: 'text', required: true },
    { id: 'owner', label: '담당자', type: 'text' },
    { id: 'status', label: '상태', type: 'status', options: ['상담중', '제안', '계약', '보류', '준비 중'] },
    { id: 'amount', label: '금액', type: 'money' },
    { id: 'due', label: '기한', type: 'date' },
  ],
  actions: [
    { id: 'create-customer', label: '신규 등록', type: 'create' },
    { id: 'update-customer', label: '선택 수정', type: 'update' },
    { id: 'change-customer-status', label: '상태 변경', type: 'change-status', field: 'status' },
    { id: 'export-customers', label: 'CSV 출력', type: 'export' },
  ],
  tableView: {
    id: 'customer-ops',
    title: '거래처 운영 현황',
    subtitle: 'local metadata renderer 샘플 · connector pilot 전환 전에도 동작하는 업무 화면',
    statusLabel: 'Preview-ready',
    columns: [
      { key: 'name', label: '거래처', kind: 'text' },
      { key: 'owner', label: '담당', kind: 'text' },
      { key: 'status', label: '상태', kind: 'status' },
      { key: 'amount', label: '금액', kind: 'money' },
      { key: 'due', label: '기한', kind: 'date' },
    ],
    rows: [
      { id: '1', name: 'DemoOrg', owner: 'Julius', status: '갱신 협의', amount: '₩12.4M', due: 'D-12' },
      { id: '2', name: 'Moat Builders', owner: 'AI Team', status: '청구 완료', amount: '₩8.8M', due: '완료' },
      { id: '3', name: 'Northstar Labs', owner: 'Ops', status: '미수 확인', amount: '₩5.1M', due: 'D+7' },
      { id: '4', name: 'Studio Orbit', owner: 'Sales', status: '계약 작성', amount: '₩3.6M', due: 'D-21' },
    ],
  },
  builder: {
    title: '화면 변경',
    description: '업무 화면의 필드, 표, 메뉴를 바꾸는 관리자용 영역입니다. 일반 업무 입력은 상단 업무 버튼을 사용하세요.',
    steps: [
      { id: 'prepare-change', label: '필요한 필드와 메뉴를 변경안으로 정리' },
      { id: 'preview-diff', label: '변경 전/후 확인' },
      { id: 'approve-publish', label: '확인 후 화면에 반영' },
    ],
    draftPreview: {
      title: '변경안 미리보기',
      summary: '예시 변경안입니다. 실제 운영에서는 화면 구성 변경 사항이 여기에 표시됩니다.',
      changes: [
        { path: 'tableView.title', before: '거래처 운영 현황', after: '고객사 파이프라인 현황', risk: 'low' },
        { path: 'tableView.columns[0].label', before: '거래처', after: '고객사', risk: 'low' },
        { path: 'source.provider', before: 'sqlite', after: 'sqlite', risk: 'low' },
      ],
    },
  },
};
