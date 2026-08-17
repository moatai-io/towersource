/**
 * UserSelfModals.tsx — 사용자 본인이 자기 프로필/비번을 관리하는 두 모달.
 *
 * 호출 위치: Header 우측 메뉴 (logout 위).
 * 백엔드: GET /api/me, PATCH /api/me/profile, POST /api/me/password
 *
 * 결정: workspace/decisions/2026-05-20-members-name-affiliation-and-credentials.md
 */
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

const API_BASE = '/api';

interface MyProfile {
  id: number;
  username: string;
  role: string;
  display_name: string | null;
  affiliation: string | null;
}

function headers(token?: string | null): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

// ───── My Profile Modal ─────

export function MyProfileModal({
  token,
  onClose,
}: {
  token?: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('layout');
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [affiliation, setAffiliation] = useState('');
  const [error, setError] = useState('');
  const [savedNote, setSavedNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/me`, { headers: headers(token) })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: MyProfile | null) => {
        if (data) {
          setProfile(data);
          setDisplayName(data.display_name ?? '');
          setAffiliation(data.affiliation ?? '');
        }
      });
  }, [token]);

  const handleSave = async () => {
    if (saving) return;
    setError('');
    setSavedNote('');
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/me/profile`, {
        method: 'PATCH',
        headers: headers(token),
        body: JSON.stringify({
          displayName: displayName.trim(),
          affiliation: affiliation.trim(),
        }),
      });
      if (res.ok) {
        const data: MyProfile = await res.json();
        setProfile(data);
        setSavedNote(t('profileSaved'));
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || t('profileSaveFailed'));
      }
    } catch {
      setError(t('profileSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-surface-900 border border-surface-700 rounded-xl shadow-2xl w-full max-w-md mx-4 p-6 space-y-4">
        <h3 className="text-[17px] font-bold text-gray-100">{t('myProfile')}</h3>

        {profile && (
          <div className="text-[14px] text-gray-500 font-mono space-y-0.5">
            <div>@{profile.username}</div>
            <div className="text-[13px] text-gray-600">{profile.role}</div>
          </div>
        )}

        <div>
          <label className="block text-[13px] text-gray-500 mb-1">{t('displayName')}</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => { setDisplayName(e.target.value); setSavedNote(''); }}
            placeholder={t('displayNamePlaceholder')}
            className="w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[15px] text-gray-200 focus:outline-none focus:border-primary-500/50"
          />
        </div>
        <div>
          <label className="block text-[13px] text-gray-500 mb-1">{t('affiliation')}</label>
          <input
            type="text"
            value={affiliation}
            onChange={(e) => { setAffiliation(e.target.value); setSavedNote(''); }}
            placeholder={t('affiliationPlaceholder')}
            className="w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[15px] text-gray-200 focus:outline-none focus:border-primary-500/50"
          />
        </div>

        {error && <div className="text-[14px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">{error}</div>}
        {savedNote && <div className="tone-card tone-success text-[14px] rounded-md px-3 py-2">{savedNote}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-[14px] text-gray-400 hover:text-gray-200 transition-colors rounded-md">
            {t('common:cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !profile}
            className="px-4 py-2 text-[14px] bg-primary-600 hover:bg-primary-500 text-white rounded-md transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('common:save', { defaultValue: 'Save' })}
          </button>
        </div>
      </div>
    </div>
  );
}

// ───── Change Password Modal ─────

export function ChangePasswordModal({
  token,
  onClose,
  onPasswordChanged,
}: {
  token?: string | null;
  onClose: () => void;
  onPasswordChanged: (newToken: string) => void;
}) {
  const { t } = useTranslation('layout');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setError('');

    if (newPassword.length < 8) { setError(t('passwordMin8')); return; }
    if (newPassword !== confirmPassword) { setError(t('passwordsDoNotMatch')); return; }
    if (newPassword === oldPassword) { setError(t('passwordsMustDiffer')); return; }

    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/me/password`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      if (res.ok) {
        const data = await res.json();
        // backend 가 새 토큰 발급 — 본인은 그 자리에서 invalidate 되지 않음.
        if (data.token) onPasswordChanged(data.token);
        onClose();
      } else if (res.status === 401) {
        setError(t('currentPasswordWrong'));
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || t('passwordChangeFailed'));
      }
    } catch {
      setError(t('passwordChangeFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <form onSubmit={handleSubmit} className="relative bg-surface-900 border border-surface-700 rounded-xl shadow-2xl w-full max-w-md mx-4 p-6 space-y-4">
        <h3 className="text-[17px] font-bold text-gray-100">{t('changePassword')}</h3>

        <div>
          <label className="block text-[13px] text-gray-500 mb-1">{t('currentPassword')}</label>
          <input
            type="password"
            value={oldPassword}
            onChange={(e) => { setOldPassword(e.target.value); setError(''); }}
            className="w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[15px] text-gray-200 focus:outline-none focus:border-primary-500/50"
            autoComplete="current-password"
            autoFocus
            required
          />
        </div>
        <div>
          <label className="block text-[13px] text-gray-500 mb-1">{t('newPassword')}</label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => { setNewPassword(e.target.value); setError(''); }}
            className="w-full bg-surface-900 border border-surface-700 rounded-md px-3 py-2 text-[15px] text-gray-200 focus:outline-none focus:border-primary-500/50"
            autoComplete="new-password"
            required
            minLength={8}
          />
        </div>
        <div>
          <label className="block text-[13px] text-gray-500 mb-1">{t('confirmNewPassword')}</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
            className={`w-full bg-surface-900 border rounded-md px-3 py-2 text-[15px] text-gray-200 focus:outline-none focus:border-primary-500/50 ${
              confirmPassword && newPassword !== confirmPassword ? 'border-red-500/50' : 'border-surface-700'
            }`}
            autoComplete="new-password"
            required
          />
        </div>

        {error && <div className="text-[14px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">{error}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-[14px] text-gray-400 hover:text-gray-200 transition-colors rounded-md">
            {t('common:cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="submit"
            disabled={saving || !oldPassword || !newPassword || !confirmPassword}
            className="px-4 py-2 text-[14px] bg-primary-600 hover:bg-primary-500 text-white rounded-md transition-colors font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? t('common:processing', { defaultValue: 'Processing...' }) : t('changePassword')}
          </button>
        </div>
      </form>
    </div>
  );
}
