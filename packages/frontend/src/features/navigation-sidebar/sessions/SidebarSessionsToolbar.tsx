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
  filterLabels: boolean;
  toggleFilter: (key: "my" | "fav" | "done" | "labels") => void;
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
  filterLabels,
  toggleFilter,
  onCollapseSidebar,
}: SidebarSessionsToolbarProps) {
  return (
    <div className="sidebar-sessions-toolbar flex min-w-0 items-center px-2 py-1 gap-0.5">
      <div className="relative ml-1 min-w-0 flex-1">
        <svg
          className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-surface-700"
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
          placeholder={t("searchSessions")}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              clearSearch();
              searchInputRef.current?.blur();
            }
          }}
          className="h-7 w-full rounded-full bg-surface-800/45 px-7 text-[13px] text-gray-300 placeholder-surface-700 outline-none transition-colors focus:bg-surface-800/70 focus:text-gray-200"
        />
        {searchQuery && (
          <button
            onClick={() => {
              clearSearch();
              searchInputRef.current?.focus();
            }}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-surface-600 hover:text-gray-300 transition-colors"
            title={t("clearSearch", { defaultValue: "검색 지우기" })}
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
      </div>
      <div className="relative">
        <button
          onClick={() => setFilterOpen(!filterOpen)}
          className={`relative flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${activeFilterLabels.length > 0 ? "border-primary-500/35 bg-primary-500/10 text-primary-400" : "border-transparent text-surface-600 hover:border-surface-700 hover:bg-surface-850 hover:text-surface-400"}`}
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
        >
          <FunnelIcon className="h-3.5 w-3.5" />
          {activeFilterLabels.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 min-w-[13px] h-[13px] px-0.5 rounded-full bg-primary-500 text-[10px] leading-[13px] text-surface-950 font-bold text-center shadow shadow-black/30">
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
            <div className="absolute right-0 top-full mt-1 z-50 bg-surface-800 border border-surface-700 rounded-lg shadow-xl py-1 min-w-[160px]">
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
                Agent 대화
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
                외부 배포 (ext)
              </FilterMenuItem>
              <div className="my-1 border-t border-surface-700/70" />
              <FilterMenuItem
                active={filterMy}
                onClick={() => toggleFilter("my")}
              >
                👤 {t("mySessions")}
              </FilterMenuItem>
              <FilterMenuItem
                active={filterFav}
                onClick={() => toggleFilter("fav")}
              >
                📌 {t("favorites")}
              </FilterMenuItem>
              <FilterMenuItem
                active={filterDone}
                onClick={() => toggleFilter("done")}
              >
                ✓ {t("done")}
              </FilterMenuItem>
              <FilterMenuItem
                active={filterLabels}
                onClick={() => toggleFilter("labels")}
              >
                📁 {t("decks")}
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
