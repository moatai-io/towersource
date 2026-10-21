import React from 'react';
import { PricingApp } from './PricingApp';
/** An explicit filename opt-in; ordinary JSON retains its normal code preview. */
export function isPricingAppFile(path: string): boolean {
  return path.toLowerCase().endsWith('.pricing-app.json');
}
export function PricingFilePreview({content}:{content:string}) {
  let declaration: unknown;
  try {
    if (content.length > 262144) throw new Error('size');
    declaration = JSON.parse(content);
  } catch { return <p role="alert">가격 화면 JSON을 읽을 수 없습니다. 형식과 파일 크기를 확인하세요.</p>; }
  return <div className="h-full overflow-auto"><PricingApp key={content} declaration={declaration} /></div>;
}
