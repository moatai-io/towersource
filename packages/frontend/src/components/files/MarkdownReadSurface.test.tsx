// @vitest-environment jsdom
import React, { Suspense } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownReadSurface } from './MarkdownReadSurface';

vi.mock('../chat/MermaidBlock', () => ({
  MermaidBlock: ({ code }: { code: string }) => <div data-testid="mermaid">{code}</div>,
}));

describe('MarkdownReadSurface', () => {
  it('renders ordinary markdown and hides YAML frontmatter', () => {
    render(<MarkdownReadSurface content={'---\ntitle: Test\n---\n# Heading\nBody'} components={{}} />);
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeTruthy();
    expect(screen.getByText('Body')).toBeTruthy();
    expect(screen.queryByText(/title: Test/)).toBeNull();
  });

  it('keeps single tildes literal while preserving double-tilde strikethrough', () => {
    const { container } = render(
      <MarkdownReadSurface
        content={'2022~2025년 매출은 증가했으나 2024~2025년에는 둔화했다. ~~삭제~~'}
        components={{}}
      />,
    );

    expect(screen.getByText(/2022~2025년 매출은 증가했으나 2024~2025년에는 둔화했다/)).toBeTruthy();
    expect(container.querySelectorAll('del')).toHaveLength(1);
    expect(container.querySelector('del')?.textContent).toBe('삭제');
  });

  it('loads Mermaid only for a Mermaid fenced block', async () => {
    render(
      <Suspense fallback={null}>
        <MarkdownReadSurface content={'Before\n```mermaid\nflowchart LR\nA --> B\n```\nAfter'} components={{}} />
      </Suspense>,
    );
    expect(screen.getByText('Before')).toBeTruthy();
    expect(screen.getByText('flowchart LR', { exact: false })).toBeTruthy();
    expect(screen.getByText('After')).toBeTruthy();
  });
});
