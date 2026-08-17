import React from 'react';
import { FileExchangeSurface } from '../../features/file-exchange/FileExchangeSurface';

function openPersonalPath(path: string) {
  window.dispatchEvent(new CustomEvent('tower-open-path', { detail: { path, split: 'right' } }));
}

/** User-owned files, notes, and Todo rendered as a dedicated Viewer Pane tab. */
export function PersonalMaterialsView() {
  return (
    <div className="flex h-full flex-col bg-surface-950 text-surface-100">
      <header className="shrink-0 border-b border-surface-800 px-4 py-4">
        <div>
          <h2 className="text-[18px] font-semibold">내 자료</h2>
          <p className="mt-1 text-[12px] leading-5 text-surface-500">노트와 업로드 파일을 구분하지 않고 한곳에서 찾습니다.</p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <FileExchangeSurface personalOnly unifiedPersonal onOpenPersonalItem={openPersonalPath} />
        <div className="flex justify-end px-1 py-4">
          <button type="button" onClick={() => openPersonalPath('personal://archive')} className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-surface-500 hover:bg-surface-900 hover:text-surface-200" aria-label="보관함 열기">··· 보관함</button>
        </div>
      </div>
    </div>
  );
}
