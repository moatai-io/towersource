import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores/session-store';

interface CredentialVaultOptions {
  id?: string;
  provider?: string;
  displayName?: string;
  secretName?: string;
  envName?: string;
  scope?: 'workspace' | 'internal-default' | 'project' | 'personal';
  grantToCurrentProject?: boolean;
  metadata?: Record<string, unknown>;
}

interface SecureField {
  key: string;
  label?: string;
  required?: boolean;
  inputType?: 'password' | 'json';
  credential?: CredentialVaultOptions;
}

interface SecureInputSpec {
  target?: string;       // e.g. ".env" (default) or "credential-vault"
  fields: SecureField[];
  credential?: CredentialVaultOptions;
}

export default function SecureInputBlock({ raw, fallbackCode }: { raw: string; fallbackCode: string }) {
  const { t } = useTranslation('chat');
  let spec: SecureInputSpec;
  try {
    spec = JSON.parse(raw);
    if (!spec.fields || !Array.isArray(spec.fields)) throw new Error('Missing fields');
  } catch {
    return (
      <pre className="my-2 bg-surface-900/60 border border-surface-700/40 rounded-lg p-4 overflow-x-auto text-base">
        <code className="tone-danger tone-text mb-2 block text-sm">{t('invalidSecureInputJson')}</code>
        <code>{fallbackCode}</code>
      </pre>
    );
  }

  return <SecureInputForm spec={spec} />;
}

function slugPart(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'credential';
}

function envName(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'SECRET_VALUE';
}

function credentialOptionsFor(spec: SecureInputSpec, field: SecureField, fieldCount: number): Required<Omit<CredentialVaultOptions, 'metadata'>> & { metadata?: Record<string, unknown> } {
  const base = spec.credential ?? {};
  const own = field.credential ?? {};
  const provider = typeof (own.provider || base.provider) === 'string' ? (own.provider || base.provider)! : 'custom';
  const safeFieldKey = typeof field.key === 'string' && field.key.trim() ? field.key.trim() : 'SECRET_VALUE';
  const fallbackEnv = envName(own.envName || base.envName || safeFieldKey);
  const fallbackId = `${slugPart(provider)}-${slugPart(safeFieldKey)}`;
  const id = own.id || (fieldCount === 1 ? base.id : undefined) || fallbackId;
  const secretName = own.secretName || (fieldCount === 1 ? base.secretName : undefined) || fallbackEnv;
  const env = own.envName || (fieldCount === 1 ? base.envName : undefined) || secretName;
  return {
    id,
    provider,
    displayName: own.displayName || (fieldCount === 1 ? base.displayName : undefined) || field.label || id,
    secretName,
    envName: env,
    scope: own.scope || base.scope || 'project',
    grantToCurrentProject: own.grantToCurrentProject ?? base.grantToCurrentProject ?? true,
    metadata: { ...(base.metadata ?? {}), ...(own.metadata ?? {}) },
  };
}

function SecureInputForm({ spec }: { spec: SecureInputSpec }) {
  const { t } = useTranslation('chat');
  const target = spec.target || '.env';
  const isCredentialVault = target === 'credential-vault';
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const storedActiveProjectId = useSessionStore((s) => s.sessions.find((session) => session.id === s.activeSessionId)?.projectId ?? null);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const [index, f] of spec.fields.entries()) {
      const key = typeof f.key === 'string' && f.key.trim() ? f.key.trim() : `SECRET_${index + 1}`;
      init[key] = '';
    }
    return init;
  });
  const [status, setStatus] = useState<'idle' | 'saving' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [savedCount, setSavedCount] = useState(0);

  const allRequiredFilled = spec.fields.every((f, index) => {
    const key = typeof f.key === 'string' && f.key.trim() ? f.key.trim() : `SECRET_${index + 1}`;
    return !f.required || String(values[key] ?? '').trim();
  });

  const handleSave = async () => {
    setStatus('saving');
    setErrorMsg('');
    try {
      const token = localStorage.getItem('token');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const entries = Object.entries(values).filter(([, v]) => String(v ?? '').trim());
      for (const [key, value] of entries) {
        const field = spec.fields.find(f => f.key === key);
        if (field?.inputType === 'json') {
          try { JSON.parse(value); } catch { throw new Error(t('invalidJsonField', { field: field.label || key })); }
        }
      }

      if (isCredentialVault) {
        const needsProjectGrant = entries.some(([key]) => {
          const field = spec.fields.find(f => f.key === key)!;
          return credentialOptionsFor(spec, field, spec.fields.length).grantToCurrentProject;
        });
        let activeProjectId = storedActiveProjectId;
        // A secure-input tool card can render before the session list has been
        // hydrated (or after a reconnect temporarily clears it). Resolve the
        // authoritative session metadata before saving so a valid project grant
        // never fails—or leaves a rotated credential only partially applied.
        if (needsProjectGrant && !activeProjectId && activeSessionId) {
          const sessionRes = await fetch(`/api/sessions/${encodeURIComponent(activeSessionId)}`, { headers });
          const sessionData = await sessionRes.json().catch(() => ({}));
          if (sessionRes.ok && typeof sessionData.projectId === 'string' && sessionData.projectId) {
            activeProjectId = sessionData.projectId;
          }
        }
        if (needsProjectGrant && !activeProjectId) throw new Error(t('noProjectForCredentialGrant'));
        const resolvedProjectId = activeProjectId;

        for (const [key, value] of entries) {
          const field = spec.fields.find(f => f.key === key)!;
          const credential = credentialOptionsFor(spec, field, spec.fields.length);
          const credentialPath = credential.scope === 'workspace'
            ? '/api/credential-vault/credentials/api-key'
            : credential.scope === 'personal'
              ? '/api/credential-vault/my/credentials/api-key'
              : `/api/credential-vault/projects/${encodeURIComponent(resolvedProjectId!)}/credentials/api-key`;
          const res = await fetch(credentialPath, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              id: credential.id,
              provider: credential.provider,
              displayName: credential.displayName,
              secretName: credential.secretName,
              secretValue: value,
              defaultEnvName: credential.envName,
              scope: credential.scope,
              metadata: credential.metadata,
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || t('credentialVaultSaveFailed', { id: credential.id }));

          // Agent-scoped creation binds in the same server request. Legacy
          // personal/workspace inputs retain the explicit policy endpoint.
          if (credential.grantToCurrentProject && credential.scope !== 'project') {
            const grantPath = credential.scope === 'personal'
              ? `/api/credential-vault/my/projects/${encodeURIComponent(resolvedProjectId!)}/policies/${encodeURIComponent(credential.id)}`
              : `/api/credential-vault/projects/${encodeURIComponent(resolvedProjectId!)}/policies/${encodeURIComponent(credential.id)}`;
            const grantRes = await fetch(grantPath, {
              method: 'PUT',
              headers,
              body: JSON.stringify({ mode: 'allow', targetEnvName: credential.envName }),
            });
            const grantData = await grantRes.json().catch(() => ({}));
            if (!grantRes.ok) throw new Error(grantData.error || t('credentialGrantFailed', { id: credential.id }));
          }
        }
      } else {
        const res = await fetch('/api/env', {
          method: 'POST',
          headers,
          body: JSON.stringify({ target, entries: entries.map(([key, value]) => ({ key, value })) }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: 'Unknown error' }));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
      }

      setSavedCount(entries.length);
      setStatus('done');
      setValues(prev => Object.fromEntries(Object.keys(prev).map(key => [key, ''])));
    } catch (err: any) {
      setErrorMsg(err.message || t('secureInputSaveFailed'));
      setStatus('error');
    }
  };

  if (status === 'done') {
    return (
      <div className="tone-card tone-success my-2 rounded-lg p-4">
        <div className="flex items-center gap-2 tone-text text-[15px] font-medium">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          {t('secureInputSaved', { count: savedCount, target: isCredentialVault ? 'Credential Vault' : target })}
        </div>
        <p className="mt-1 text-[13px] text-surface-500">{t('secureInputNotInHistoryOrContext')}</p>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-lg border border-surface-700/40 bg-surface-900/60 p-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <svg className="tone-warning tone-text w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
        <span className="text-[15px] font-medium text-surface-200">{t('secureInput')}</span>
        <span className="text-[12px] text-surface-500 ml-auto">{isCredentialVault ? 'Credential Vault' : target}</span>
      </div>

      {/* Fields */}
      <div className="space-y-2">
        {spec.fields.map(field => {
          const credential = isCredentialVault ? credentialOptionsFor(spec, field, spec.fields.length) : null;
          return (
            <div key={field.key}>
              <label className="mb-0.5 block text-[13px] text-surface-400">
                {field.label || field.key}
                {field.required && <span className="tone-warning tone-text ml-0.5">*</span>}
              </label>
              {field.inputType === 'json' ? (
                <textarea
                  value={values[field.key] || ''}
                  onChange={(e) => setValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                  placeholder={t('serviceAccountJsonPlaceholder')}
                  rows={8}
                  className="w-full resize-y rounded-md border border-surface-700 bg-surface-800 px-3 py-2 font-mono text-[14px] text-surface-200 outline-none transition-colors placeholder:text-surface-600 focus:border-primary-500 focus-visible:ring-2 focus-visible:ring-primary-400"
                  autoComplete="off"
                  data-1p-ignore
                />
              ) : (
                <input
                  type="password"
                  value={values[field.key] || ''}
                  onChange={(e) => setValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                  placeholder={field.key}
                  className="min-h-11 w-full rounded-md border border-surface-700 bg-surface-800 px-3 py-1.5 font-mono text-[14px] text-surface-200 outline-none transition-colors placeholder:text-surface-600 focus:border-primary-500 focus-visible:ring-2 focus-visible:ring-primary-400"
                  autoComplete="off"
                  data-1p-ignore
                />
              )}
              {credential && (
                <div className="mt-1 text-[11px] text-surface-500 font-mono">
                  {credential.scope === 'project'
                    ? t('credentialSavedForCurrentAgent', { envName: credential.envName })
                    : `${credential.id} · ${credential.envName} · ${credential.scope}`}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Error */}
      {status === 'error' && (
        <div className="tone-danger tone-text mt-2 text-[13px]">{errorMsg}</div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between mt-3">
        <span className="text-[12px] text-surface-500 flex items-center gap-1">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {t('secureInputNotStoredInChat')}{isCredentialVault ? ` · ${t('vaultMetadataOnly')}` : ''}
        </span>
        <button
          onClick={handleSave}
          disabled={!allRequiredFilled || status === 'saving'}
          className="flex min-h-11 items-center gap-1.5 rounded-md bg-primary-600 px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-primary-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:cursor-not-allowed disabled:bg-surface-800 disabled:text-surface-500"
        >
          {status === 'saving' ? (
            <>
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              {t('saving')}
            </>
          ) : (
            <>
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              {t('saveToTarget', { target: isCredentialVault ? 'Vault' : target })}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
