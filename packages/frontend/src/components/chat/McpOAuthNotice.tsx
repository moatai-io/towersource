import { useEffect } from 'react';
import { toastError, toastSuccess } from '../../utils/toast';

/** Callback returns only a fixed result marker: tokens and provider errors never enter the URL. */
export function McpOAuthNotice() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get('mcpAuth');
    if (!result) return;
    url.searchParams.delete('mcpAuth');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    if (result === 'connected') toastSuccess('Agent 공용 MCP 인증을 저장했습니다. 커넥터 메뉴에서 연결을 확인하세요.');
    else if (result === 'error') toastError('MCP 인증을 완료하지 못했습니다. 연결 관리에서 다시 로그인해 주세요.');
  }, []);
  return null;
}
