import React from 'react';

/** UI identity only; does not create an Agent or change Project authority. */
export function SecretariatFace({ className = 'h-12 w-12' }: { className?: string }) {
  return <img src="/agent-characters/core-talent.webp" alt="" aria-hidden="true" className={`${className} shrink-0 object-contain`} />;
}
