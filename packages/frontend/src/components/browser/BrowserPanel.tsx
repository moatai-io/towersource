interface BrowserPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Deprecated BrowserPanel.
 *
 * The old panel proxied `/api/browser/*` to a host-level browser daemon. Tower
 * web capture now uses Runtime Box Playwright/system Chromium so browser work is
 * project-scoped and reproducible. Keep this component as a no-op compatibility
 * shell until old UI entry points are fully removed.
 */
export function BrowserPanel({ open, onClose }: BrowserPanelProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[520px] rounded-xl border border-neutral-700 bg-neutral-900 p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-widest text-gray-400">Browser tool deprecated</p>
            <p className="mt-3 text-sm leading-6 text-gray-300">
              The legacy browser panel has been deprecated. Use Runtime Box Playwright/web-capture for
              project-scoped page reads, screenshots, and PDF captures.
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-gray-500 transition-colors hover:text-gray-300">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
