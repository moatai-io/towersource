// Owns: Sidebar Session 검색·필터 toolbar 표현. Public API: SidebarSessionsToolbar. See ../README.md.
import type { RefObject } from "react";
import type { TFunction } from "i18next";
import type { SessionKindFilter } from "../../../utils/session-list-filters";

interface SidebarSessionsToolbarProps {
  t: TFunction<"layout">;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  clearSearch: () => void;
  filterOpen: boolean;
  setFilterOpen: (open: boolean) => void;
  activeFilterLabels: string[];
  sessionKindFilter: SessionKindFilter;
  setKindFilter: (filter: SessionKindFilter) => void;
  filterMy: boolean;
  filterFav: boolean;
  filterDone: boolean;
  filterRunning: boolean;
  filterAwaiting: boolean;
  filterLabels: boolean;
  includeArchived: boolean;
  toggleIncludeArchived: () => void;
  toggleFilter: (key: "my" | "fav" | "done" | "running" | "awaiting" | "labels") => void;
  resetFilters: () => void;
  isMobile?: boolean;
  onCollapseSidebar?: () => void;
}

/** Session 검색과 저장형 필터를 표시하며 상태 변경은 상위 Sidebar callback에 위임한다. */
export function SidebarSessionsToolbar({
  t,
  searchInputRef,
  searchQuery,
  setSearchQuery,
  clearSearch,
  filterOpen,
  setFilterOpen,
  activeFilterLabels,
  sessionKindFilter,
  setKindFilter,
  filterMy,
  filterFav,
  filterDone,
  filterRunning,
  filterAwaiting,
  filterLabels,
  includeArchived,
  toggleIncludeArchived,
  toggleFilter,
  resetFilters,
  isMobile = false,
  onCollapseSidebar,
}: SidebarSessionsToolbarProps) {
  return (
    <div className={isMobile ? "sidebar-sessions-toolbar absolute right-2 top-2 z-30" : "sidebar-sessions-toolbar border-b px-2 py-1.5"}>
      <div className={`flex min-w-0 items-center gap-1.5 ${isMobile ? "justify-end" : ""}`}>
        {!isMobile && <div className="relative min-w-0 flex-1">
        <svg
          className="sidebar-session-search-icon absolute left-1 top-1/2 h-3 w-3 -translate-y-1/2 text-surface-700"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          ref={searchInputRef}
          type="text"
          name="tower-session-query"
          role="searchbox"
          aria-label={t("searchSessions")}
          autoComplete="new-password"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          data-form-type="other"
          data-1p-ignore="true"
          data-bwignore="true"
          data-lpignore="true"
          data-protonpass-ignore="true"
          placeholder={t("searchSessions")}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              clearSearch();
              searchInputRef.current?.blur();
            }
          }}
          className="sidebar-session-search h-7 w-full border-0 border-b bg-transparent py-0 pl-6 pr-7 text-[13px] text-gray-300 outline-none transition-colors placeholder-surface-700"
        />
        {searchQuery && (
          <button
            onClick={() => {
              clearSearch();
              searchInputRef.current?.focus();
            }}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-surface-600 hover:text-gray-300 transition-colors"
            title={t("clearSearch")}
          >
            <svg
              className="w-3 h-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
        </div>}
        <div className="relative">
        <button
          onClick={() => setFilterOpen(!filterOpen)}
          className={`relative flex h-7 shrink-0 items-center justify-center rounded-md transition-colors ${isMobile ? "w-7" : "gap-1.5 border px-2 text-[12px] font-semibold"} ${activeFilterLabels.length > 0 ? "border-primary-500/35 bg-primary-500/10 text-primary-700 dark:text-primary-300" : isMobile ? "text-surface-600 hover:bg-surface-800 hover:text-surface-300" : "border-surface-700/80 bg-surface-850/65 text-surface-500 hover:border-surface-600 hover:bg-surface-850 hover:text-surface-300"}`}
          title={
            activeFilterLabels.length > 0
              ? `${t("filters")}: ${activeFilterLabels.join(", ")}`
              : t("filters")
          }
          aria-label={
            activeFilterLabels.length > 0
              ? `${t("filters")}: ${activeFilterLabels.join(", ")}`
              : t("filters")
          }
          aria-pressed={activeFilterLabels.length > 0}
          aria-expanded={filterOpen}
        >
          <FunnelIcon className="h-3.5 w-3.5" />
          {!isMobile && <span>{t("filters")}</span>}
          {activeFilterLabels.length > 0 && (
            <span className={isMobile ? "absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-primary-500 px-0.5 text-center text-[9px] font-bold leading-3.5 text-surface-950" : "min-w-[16px] rounded-full bg-primary-500 px-1 text-center text-[10px] font-bold leading-4 text-surface-950"}>
              {activeFilterLabels.length}
            </span>
          )}
        </button>
        {filterOpen && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setFilterOpen(false)}
            />
            <div className="absolute right-0 top-full mt-1 z-50 min-w-[220px] rounded-lg border border-surface-700 bg-surface-800 py-1 shadow-xl">
              <div className="px-3 pb-1 pt-1 text-[12px] font-semibold uppercase tracking-wide text-surface-500">
                {t("sessionType")}
              </div>
              <FilterMenuItem
                active={sessionKindFilter === "all"}
                onClick={() => setKindFilter("all")}
              >
                {t("common:all")}
              </FilterMenuItem>
              <FilterMenuItem
                active={sessionKindFilter === "chats"}
                onClick={() => setKindFilter("chats")}
              >
                {t("chats")}
              </FilterMenuItem>
              <FilterMenuItem
                active={sessionKindFilter === "agents"}
                onClick={() => setKindFilter("agents")}
              >
                {t("agentConversations")}
              </FilterMenuItem>
              <FilterMenuItem
                active={sessionKindFilter === "runs"}
                onClick={() => setKindFilter("runs")}
              >
                {t("runs")}
              </FilterMenuItem>
              <FilterMenuItem
                active={sessionKindFilter === "external"}
                onClick={() => setKindFilter("external")}
              >
                {t("externalDeploymentsWithExtension")}
              </FilterMenuItem>
              <div className="my-1 border-t border-surface-700/70" />
              <div className="px-3 pb-1 pt-1 text-[12px] font-semibold uppercase tracking-wide text-surface-500">
                {t("filterStatus")}
              </div>
              <FilterMenuItem active={filterRunning} onClick={() => toggleFilter("running")}>
                {t("filterRunning")}
              </FilterMenuItem>
              <FilterMenuItem active={filterAwaiting} onClick={() => toggleFilter("awaiting")}>
                {t("filterAwaiting")}
              </FilterMenuItem>
              <FilterMenuItem active={filterDone} onClick={() => toggleFilter("done")}>
                {t("filterNeedsReview")}
              </FilterMenuItem>
              <div className="my-1 border-t border-surface-700/70" />
              <div className="px-3 pb-1 pt-1 text-[12px] font-semibold uppercase tracking-wide text-surface-500">
                {t("filterRelationship")}
              </div>
              <FilterMenuItem
                active={filterMy}
                onClick={() => toggleFilter("my")}
              >
                {t("participatedSessions")}
              </FilterMenuItem>
              <FilterMenuItem
                active={filterFav}
                onClick={() => toggleFilter("fav")}
              >
                {t("favorites")}
              </FilterMenuItem>
              <FilterMenuItem
                active={includeArchived}
                onClick={toggleIncludeArchived}
              >
                {t("includeArchivedSessions")}
              </FilterMenuItem>
              <div className="my-1 border-t border-surface-700/70" />
              <div className="px-3 pb-1 pt-1 text-[12px] font-semibold uppercase tracking-wide text-surface-500">
                {t("filterView")}
              </div>
              <FilterMenuItem active={filterLabels} onClick={() => toggleFilter("labels")}>
                {t("groupByDeck")}
              </FilterMenuItem>
            </div>
          </>
        )}
        </div>
      {onCollapseSidebar && (
        <button
          onClick={onCollapseSidebar}
          className="p-1.5 text-surface-600 hover:text-surface-400 hover:bg-surface-850 rounded-md transition-colors"
          title={t("hideSidebar")}
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </button>
      )}
      </div>
      {!isMobile && activeFilterLabels.length > 0 && (
        <div className="mt-1.5 flex min-w-0 items-center gap-1" aria-label={t("activeFilters")}>
          <div className="flex min-w-0 flex-1 flex-wrap gap-1">
            {activeFilterLabels.map((label) => (
              <span key={label} className="inline-flex max-w-full items-center rounded-full border border-primary-500/25 bg-primary-500/10 px-2 py-0.5 text-[11px] font-medium text-primary-700 dark:text-primary-300">
                <span className="truncate">{label}</span>
              </span>
            ))}
          </div>
          <button type="button" onClick={resetFilters} className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-surface-500 hover:bg-surface-800 hover:text-surface-300">
            {t("clearFilters")}
          </button>
        </div>
      )}
    </div>
  );
}

function FilterMenuItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-[14px] transition-colors ${active ? "text-primary-400 bg-primary-500/10" : "text-gray-400 hover:bg-surface-700 hover:text-gray-300"}`}
    >
      <span
        className={`w-3 h-3 rounded border flex items-center justify-center text-[10px] ${active ? "border-primary-400 bg-primary-500/20 text-primary-300" : "border-surface-600"}`}
      >
        {active ? "✓" : ""}
      </span>
      {children}
    </button>
  );
}

function FunnelIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.9}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 5.25h16.5l-6.5 7.2v4.85l-3.5 1.45v-6.3l-6.5-7.2z"
      />
    </svg>
  );
}
