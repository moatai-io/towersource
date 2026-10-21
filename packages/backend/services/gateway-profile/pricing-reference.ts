// Public list-price reference, not customer invoices or an automatic billing calculator.
export interface GatewayPriceReference {
  apiId: string;
  useCase: string;
  status: 'published' | 'plan-dependent' | 'unconfirmed';
  currency?: 'USD' | 'KRW';
  unit: string;
  rate?: number;
  sourceUrl: string;
  checkedAt: string;
  caveat: string;
}
const checkedAt = '2026-10-13';
export const gatewayPriceReferences: readonly GatewayPriceReference[] = [
  { apiId: 'speech-to-text', useCase: 'Realtime dictation: gpt-live-transcribe', status: 'published', currency: 'USD', unit: 'audio-minute', rate: 0.017, sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-live-transcribe', checkedAt: '2026-10-14', caveat: 'Realtime audio duration. Provider cost only; excludes gateway, tax and customer markup. Estimate against microphone-open minutes including silence.' },
  { apiId: 'firecrawl', useCase: 'WebFetch: standard scrape', status: 'plan-dependent', currency: 'USD', unit: 'credit', sourceUrl: 'https://www.firecrawl.dev/pricing', checkedAt, caveat: 'Standard scrape: 1 credit/page; pricing-page search allowance implies 2 credits/search; confirm endpoint result-count and add-on rules before estimating an individual query. Annual Hobby $16/month for 5,000 credits; Standard $83/month for 100,000. Subscription allocation is not marginal request cost; extra features may consume more credits.' },
  { apiId: 'apify', useCase: 'Actor compute', status: 'plan-dependent', currency: 'USD', unit: 'compute-unit', sourceUrl: 'https://apify.com/pricing', checkedAt, caveat: 'Starter $19/month includes $19 usage, $0.20/CU; Scale $199/month includes $199 usage, $0.16/CU. Actor event fees, storage and proxies are separate; never assume every Actor bills only CU.' },
  { apiId: 'apify', useCase: 'YouTube transcripts: karamelo/youtube-transcripts', status: 'published', currency: 'USD', unit: 'transcript', rate: 0.005, sourceUrl: 'https://apify.com/karamelo/youtube-transcripts', checkedAt, caveat: 'Published starting price $5/1,000 transcripts, not a guaranteed all-in invoice or a per-video-minute price.' },
  { apiId: 'openrouter-jev', useCase: 'typesafe/jev-1.13 structured decisions: input', status: 'published', currency: 'USD', unit: 'input-token', rate: 0.000000042, sourceUrl: 'https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints', checkedAt, caveat: '$0.042/1M input tokens; endpoint-specific list price. Credit purchase fees are separate.' },
  { apiId: 'openrouter-jev', useCase: 'typesafe/jev-1.13 structured decisions: output', status: 'published', currency: 'USD', unit: 'output-token', rate: 0, sourceUrl: 'https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints', checkedAt, caveat: 'Explicit published zero output-token rate, not unknown pricing.' },
  { apiId: 'openai-image', useCase: 'gpt-image-2.5-sunburst: standard image input', status: 'published', currency: 'USD', unit: 'image-input-token', rate: 0.000008, sourceUrl: 'https://developers.openai.com/api/docs/pricing.md', checkedAt, caveat: '$8/1M image input tokens; cached image input $2/1M; text input $5/1M, cached text $1.25/1M. Batch prices must not replace standard prices.' },
  { apiId: 'openai-image', useCase: 'gpt-image-2.5-sunburst: standard image output', status: 'published', currency: 'USD', unit: 'image-output-token', rate: 0.000030, sourceUrl: 'https://developers.openai.com/api/docs/pricing.md', checkedAt, caveat: '$30/1M output tokens. Per-image cost depends on size, quality and input; slides, character images and edits must not use one fixed per-image price.' },
  { apiId: 'openai', useCase: 'STT: gpt-transcribe', status: 'published', currency: 'USD', unit: 'audio-minute', rate: 0.0045, sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-transcribe', checkedAt, caveat: 'Published audio-duration price: $0.0045/minute ($0.27/hour). Applies to gpt-transcribe, not gpt-4o-transcribe. Price reference is not proof of live route deployment.' },
  { apiId: 'corepin', useCase: 'Document parse', status: 'published', currency: 'KRW', unit: 'page', rate: 2, sourceUrl: 'https://corepin.ai/pricing', checkedAt, caveat: 'Public unified document parser list price. OCR modes and contract terms may differ; free allowances must not be represented as permanently zero cost. Local seed remains a candidate, not proof of live route registration.' },
  { apiId: 'naver', useCase: 'News/blog search', status: 'published', currency: 'KRW', unit: 'request', rate: 0, sourceUrl: 'https://developers.naver.com/products/service-api/search/search.md', checkedAt, caveat: 'Current free provider usage confirmed by the commissioning user on 2026-10-13; fetched product page does not independently substantiate the price. Gateway overhead and quota are separate.' },
  { apiId: 'agent-store', useCase: 'MCP tools', status: 'unconfirmed', unit: 'tool-specific-credit', sourceUrl: 'https://zuplo.com/pricing', checkedAt, caveat: 'Zuplo platform pricing does not establish upstream Agent Store tool prices. Requires actual tool/provider inventory and applicable agreement.' },
  { apiId: 'zuplo-platform', useCase: 'Gateway hosting', status: 'unconfirmed', unit: 'plan/month-and-volume', sourceUrl: 'https://zuplo.com/pricing', checkedAt, caveat: 'Separate fixed/shared gateway overhead from provider usage. Current page uses custom volume pricing; actual contracted subscription and overage rates require account evidence. Do not reuse historical Builder prices.' },
];
