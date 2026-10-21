import React from 'react';

type AppView = string;

interface AppContentRouterProps {
  activeView: AppView;
  hasActiveFileTab: boolean;
  hasActiveSystemTab: boolean;
  sessionDirectory: React.ReactNode;
  schedules: React.ReactNode;
  inbox: React.ReactNode;
  secretariat?: React.ReactNode;
  work: React.ReactNode;
  favorites: React.ReactNode;
  aiTeam: React.ReactNode;
  aiServices: React.ReactNode;
  aiServicesEnabled: boolean;
  beta: React.ReactNode;
  projectFiles: React.ReactNode;
  systemTab?: React.ReactNode;
  rooms?: React.ReactNode;
  mobileSessionLoading?: React.ReactNode;
  fallback: React.ReactNode;
}

/**
 * Selects the primary application surface independently from desktop/mobile
 * chrome. App.tsx owns composition and callbacks; this component owns the
 * precedence rules shared by both layouts.
 */
export function AppContentRouter({
  activeView,
  hasActiveFileTab,
  hasActiveSystemTab,
  sessionDirectory,
  schedules,
  inbox,
  secretariat,
  work,
  favorites,
  aiTeam,
  aiServices,
  aiServicesEnabled,
  beta,
  projectFiles,
  systemTab,
  rooms,
  mobileSessionLoading,
  fallback,
}: AppContentRouterProps) {
  if (sessionDirectory && !hasActiveSystemTab) return sessionDirectory;
  if (activeView === 'schedules' && !hasActiveSystemTab) return schedules;
  if (activeView === 'inbox') return inbox;
  if (activeView === 'secretariat' && !hasActiveSystemTab) return secretariat;
  if (activeView === 'work') return work;
  if (activeView === 'favorites') return favorites;
  if (activeView === 'aiTeam') return aiTeam;
  if (activeView === 'aiServices' && aiServicesEnabled) return aiServices;
  if (activeView === 'beta') return beta;
  if (activeView === 'projectFiles' && !hasActiveFileTab && !hasActiveSystemTab) return projectFiles;
  if (hasActiveSystemTab && systemTab) return systemTab;
  if (activeView === 'rooms' && rooms) return rooms;
  if (mobileSessionLoading) return mobileSessionLoading;
  return fallback;
}
