import { useTranslation } from 'react-i18next';
import type { ModelOption } from '../../stores/model-store';
import { getModelPriceLabel } from './model-display';

/** Only show a complete, LiteLLM-reported pair of USD rates. */
export function ModelTokenPrice({ model }: { model: ModelOption }) {
  const { t } = useTranslation('layout');
  const price = getModelPriceLabel(model);
  if (!price) return null;

  return (
    <span className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] leading-4 tabular-nums">
      <span className="text-surface-500">{t('modelPriceInput')} <span className="font-medium text-surface-300">${price.input}</span></span>
      <span className="text-surface-500">{t('modelPriceOutput')} <span className="font-medium text-surface-300">${price.output}</span></span>
      <span className="text-[10px] text-surface-600">{t('modelPriceUnit')}</span>
    </span>
  );
}
