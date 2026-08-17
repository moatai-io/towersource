import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emitProductNotice } from './product-notice';
import { toastError, toastInfo, toastSuccess, toastWarning } from './toast';

vi.mock('./toast', () => ({
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));

describe('emitProductNotice', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows stable user copy instead of raw technical detail', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    emitProductNotice({
      code: 'oauth.connect.failed',
      context: { provider: 'google' },
      technicalDetail: new Error('invalid_client: secret leaked from provider response'),
    });
    expect(toastError).toHaveBeenCalledWith('계정 연결을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.');
    expect(toastError).not.toHaveBeenCalledWith(expect.stringContaining('invalid_client'));
    expect(warn).toHaveBeenCalledWith('[product-notice]', expect.objectContaining({
      code: 'oauth.connect.failed',
      technicalDetail: 'invalid_client: secret leaked from provider response',
    }));
    warn.mockRestore();
  });

  it('routes semantic levels through the shared toast presenter', () => {
    emitProductNotice({ code: 'runtime.logs.load.failed', level: 'warning' });
    expect(toastWarning).toHaveBeenCalledWith('서비스 로그를 불러오지 못했어요.');
    expect(toastInfo).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
