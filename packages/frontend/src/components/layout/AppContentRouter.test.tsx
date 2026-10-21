import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppContentRouter } from './AppContentRouter';

const surface = (name: string) => <div>{name}</div>;

function render(overrides: Partial<React.ComponentProps<typeof AppContentRouter>> = {}) {
  return renderToStaticMarkup(<AppContentRouter
    activeView="chat"
    hasActiveFileTab={false}
    hasActiveSystemTab={false}
    sessionDirectory={null}
    schedules={surface('schedules')}
    inbox={surface('inbox')}
    secretariat={surface('secretariat')}
    work={surface('work')}
    favorites={surface('favorites')}
    aiTeam={surface('ai-team')}
    aiServices={surface('ai-services')}
    aiServicesEnabled
    beta={surface('beta')}
    projectFiles={surface('project-files')}
    fallback={surface('fallback')}
    {...overrides}
  />);
}

describe('AppContentRouter', () => {
  it('gives the session directory precedence over ordinary views', () => {
    expect(render({ activeView: 'work', sessionDirectory: surface('directory') })).toContain('directory');
  });

  it('selects shared application views without depending on desktop/mobile chrome', () => {
    expect(render({ activeView: 'inbox' })).toContain('inbox');
    expect(render({ activeView: 'secretariat' })).toContain('secretariat');
    expect(render({ activeView: 'secretariat', hasActiveSystemTab: true, systemTab: surface('system') })).toContain('system');
    expect(render({ activeView: 'work' })).toContain('work');
    expect(render({ activeView: 'favorites' })).toContain('favorites');
    expect(render({ activeView: 'aiTeam' })).toContain('ai-team');
    expect(render({ activeView: 'beta' })).toContain('beta');
  });

  it('uses system, room, loading, and fallback surfaces in precedence order', () => {
    expect(render({ hasActiveSystemTab: true, systemTab: surface('system') })).toContain('system');
    expect(render({ activeView: 'rooms', rooms: surface('rooms') })).toContain('rooms');
    expect(render({ mobileSessionLoading: surface('loading') })).toContain('loading');
    expect(render()).toContain('fallback');
  });
});
