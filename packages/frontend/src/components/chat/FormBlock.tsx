import { useMemo, useState, useCallback } from 'react';
import { useSettingsStore } from '../../stores/settings-store';
import { parseLooseJson } from '../shared/parse-loose-json';
import { BlockFallback } from '../shared/RichContent';
import { useTranslation } from 'react-i18next';

interface FormField {
  key: string;
  label?: string;
  type?: 'text' | 'number' | 'select' | 'checkbox' | 'date' | 'textarea';
  required?: boolean;
  options?: string[];
  placeholder?: string;
  defaultValue?: any;
}

interface FormSpec {
  title?: string;
  description?: string;
  fields: FormField[];
  submitLabel?: string;
}

interface Props {
  raw: string;
  fallbackCode: string;
  onSubmit?: (values: Record<string, any>) => void;
}

export default function FormBlock({ raw, fallbackCode, onSubmit }: Props) {
  const { t } = useTranslation('chat');
  const theme = useSettingsStore((s) => s.theme);
  const isDark = theme !== 'light';
  const [submitted, setSubmitted] = useState(false);

  const parsed = useMemo(() => {
    const r = parseLooseJson(raw);
    if (!r.ok) return { ok: false as const, error: r.error };
    const spec = r.data as FormSpec;
    if (!spec.fields || !Array.isArray(spec.fields)) return { ok: false as const, error: 'Missing "fields" array' };
    return { ok: true as const, spec };
  }, [raw]);

  const [values, setValues] = useState<Record<string, any>>(() => {
    if (!parsed.ok) return {};
    const init: Record<string, any> = {};
    for (const f of parsed.spec.fields) {
      init[f.key] = f.defaultValue ?? (f.type === 'checkbox' ? [] : '');
    }
    return init;
  });

  const handleChange = useCallback((key: string, value: any) => {
    setValues(prev => ({ ...prev, [key]: value }));
  }, []);

  const handleCheckbox = useCallback((key: string, option: string, checked: boolean) => {
    setValues(prev => {
      const arr = Array.isArray(prev[key]) ? [...prev[key]] : [];
      if (checked) arr.push(option);
      else { const idx = arr.indexOf(option); if (idx >= 0) arr.splice(idx, 1); }
      return { ...prev, [key]: arr };
    });
  }, []);

  if (!parsed.ok) return <BlockFallback raw={fallbackCode} error={parsed.error} />;
  const { spec } = parsed;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    onSubmit?.(values);
  };

  const inputCls = `w-full px-2.5 py-1.5 rounded-md text-base border transition-colors ${
    isDark
      ? 'bg-surface-800 border-surface-600 text-gray-200 focus:border-primary-500'
      : 'bg-white border-gray-300 text-gray-800 focus:border-primary-500'
  } focus:outline-none focus:ring-1 focus:ring-primary-500/30`;

  return (
    <div className="my-3 rounded-lg border border-surface-700/40 bg-surface-900/40 p-4">
      {spec.title && (
        <div className="text-base font-medium text-gray-300 mb-1">{spec.title}</div>
      )}
      {spec.description && (
        <div className="text-sm text-gray-500 mb-3">{spec.description}</div>
      )}

      {submitted ? (
        <div className="tone-success tone-text text-base py-2">
          {t('submitted')}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          {spec.fields.map((field) => (
            <div key={field.key}>
              <label className={`block text-sm font-medium mb-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                {field.label || field.key}
                {field.required && <span className="text-red-400 ml-0.5">*</span>}
              </label>

              {field.type === 'select' && field.options ? (
                <select
                  value={values[field.key] || ''}
                  onChange={(e) => handleChange(field.key, e.target.value)}
                  className={inputCls}
                  required={field.required}
                >
                  <option value="">{t('selectPlaceholder')}</option>
                  {field.options.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              ) : field.type === 'checkbox' && field.options ? (
                <div className="flex flex-wrap gap-2">
                  {field.options.map((opt) => (
                    <label key={opt} className={`flex items-center gap-1.5 text-sm ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                      <input
                        type="checkbox"
                        checked={(values[field.key] || []).includes(opt)}
                        onChange={(e) => handleCheckbox(field.key, opt, e.target.checked)}
                        className="rounded border-surface-600"
                      />
                      {opt}
                    </label>
                  ))}
                </div>
              ) : field.type === 'textarea' ? (
                <textarea
                  value={values[field.key] || ''}
                  onChange={(e) => handleChange(field.key, e.target.value)}
                  className={`${inputCls} min-h-[60px] resize-y`}
                  placeholder={field.placeholder}
                  required={field.required}
                />
              ) : (
                <input
                  type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                  value={values[field.key] || ''}
                  onChange={(e) => handleChange(field.key, field.type === 'number' ? Number(e.target.value) : e.target.value)}
                  className={inputCls}
                  placeholder={field.placeholder}
                  required={field.required}
                />
              )}
            </div>
          ))}

          <button
            type="submit"
            className="px-4 py-1.5 rounded-md text-base font-medium bg-primary-600 hover:bg-primary-500 text-white transition-colors"
          >
            {spec.submitLabel || t('submit')}
          </button>
        </form>
      )}
    </div>
  );
}
