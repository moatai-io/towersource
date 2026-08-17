import React, { useMemo } from 'react';
import { safeStr } from '../shared/parse-loose-json';
import { useTranslation } from 'react-i18next';

interface CadEvidenceItem {
  label?: string;
  file?: string;
  entityId?: string;
  textId?: string;
  blockInstanceId?: string;
  semanticObjectId?: string;
  cadModelArtifactPath?: string;
  handle?: string;
  layer?: string;
  block?: string;
  text?: string;
  insert?: [number, number, number?] | number[];
  bounds?: [number, number, number, number] | number[];
  confidence?: 'read' | 'inferred' | 'needs_review' | string;
  note?: string;
}

interface CadEvidencePayload {
  title?: string;
  items?: CadEvidenceItem[];
}

function parsePayload(raw: string): CadEvidencePayload {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return { items: parsed };
  return parsed && typeof parsed === 'object' ? parsed : { items: [] };
}

function confidenceClass(confidence?: string): string {
  if (confidence === 'read') return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200';
  if (confidence === 'needs_review') return 'border-amber-500/25 bg-amber-500/10 text-amber-200';
  return 'border-sky-500/25 bg-sky-500/10 text-sky-200';
}

function emitCadEvidence(item: CadEvidenceItem) {
  window.dispatchEvent(new CustomEvent('tower:cad-evidence-focus', { detail: item }));
}

export default function CadEvidenceBlock({ raw, fallbackCode }: { raw: string; fallbackCode?: string }) {
  const { t } = useTranslation('chat');
  const payload = useMemo(() => {
    try {
      return { ok: true as const, value: parsePayload(raw) };
    } catch (error: any) {
      return { ok: false as const, error: error?.message || 'Invalid cad-evidence JSON' };
    }
  }, [raw]);

  if (!payload.ok) {
    return (
      <pre className="my-2 overflow-x-auto rounded-lg border border-red-500/20 bg-red-950/20 p-3 text-[13px] text-red-200">
        <code>{payload.error}\n{fallbackCode || raw}</code>
      </pre>
    );
  }

  const items = payload.value.items || [];
  if (items.length === 0) return null;

  return (
    <div className="my-2 rounded-lg border border-cyan-500/20 bg-cyan-950/10 p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-cyan-200/80">
          {payload.value.title || t('cadEvidence')}
        </div>
        <div className="text-[11px] text-surface-500">{t('linkedToDrawingPreview')}</div>
      </div>
      <div className="space-y-2">
        {items.map((item, idx) => {
          const meta = [
            item.semanticObjectId ? `semantic ${item.semanticObjectId}` : null,
            item.entityId ? `entity ${item.entityId}` : null,
            item.textId ? `text ${item.textId}` : null,
            item.blockInstanceId ? `block id ${item.blockInstanceId}` : null,
            item.handle ? `handle ${item.handle}` : null,
            item.layer ? `layer ${item.layer}` : null,
            item.block ? `block ${item.block}` : null,
            item.insert ? `insert ${item.insert.slice(0, 2).join(', ')}` : null,
            item.bounds ? `bounds ${item.bounds.join(', ')}` : null,
          ].filter(Boolean).join(' · ');
          return (
            <div key={idx} className="rounded-md border border-surface-700/40 bg-surface-900/45 p-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[14px] font-medium text-gray-200">{safeStr(item.label) || t('evidenceNumber', { number: idx + 1 })}</div>
                  {meta && <div className="mt-0.5 text-[12px] text-gray-500">{meta}</div>}
                  {item.text && <div className="mt-1 rounded bg-surface-950/40 px-2 py-1 text-[12px] text-gray-400">“{safeStr(item.text)}”</div>}
                  {item.note && <div className="mt-1 text-[12px] text-gray-500">{safeStr(item.note)}</div>}
                </div>
                <button
                  type="button"
                  onClick={() => emitCadEvidence(item)}
                  className="shrink-0 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-1 text-[12px] font-medium text-cyan-200 transition-colors hover:bg-cyan-500/20"
                >
                  {t('viewInDrawing')}
                </button>
              </div>
              {item.confidence && (
                <span className={`mt-2 inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${confidenceClass(item.confidence)}`}>
                  {item.confidence}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
