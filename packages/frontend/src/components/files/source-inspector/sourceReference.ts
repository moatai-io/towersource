// Owns: frontend contract for attaching trusted source references to chat.

export interface ComposerSourceReference {
  version: 1;
  id: string;
  path: string;
  language: 'html';
  kind: 'element';
  tagName: string;
  start: number;
  end: number;
  lineStart: number;
  lineEnd: number;
  source: string;
  confidence: 'exact';
  mappingProvider: 'html-parser';
}

export interface AttachComposerSourceDetail {
  reference: ComposerSourceReference;
}

export const ATTACH_COMPOSER_SOURCE_EVENT = 'tower:composer-attach-source';

export function dispatchComposerSourceReference(reference: ComposerSourceReference) {
  const event = () => new CustomEvent<AttachComposerSourceDetail>(ATTACH_COMPOSER_SOURCE_EVENT, {
    detail: { reference },
  });
  window.dispatchEvent(event());
  try {
    if (window.opener && window.opener !== window && !window.opener.closed) {
      window.opener.dispatchEvent(event());
    }
  } catch {
    // Cross-origin openers are intentionally inaccessible. The local viewer can
    // still show the selection even when it cannot reach a Tower composer.
  }
}

export function formatSourceReferenceForMessage(reference: ComposerSourceReference): string {
  return `<tower_source_reference_json>\n${JSON.stringify(reference, null, 2)}\n</tower_source_reference_json>`;
}
