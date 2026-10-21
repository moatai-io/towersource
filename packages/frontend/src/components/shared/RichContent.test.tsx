// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { RichContent } from './RichContent';
import '../../i18n';
import i18n from '../../i18n';

beforeAll(async () => { await i18n.changeLanguage('en'); });

describe('RichContent file path links', () => {
  it('opens a portable workspace HTML path wrapped in inline code', () => {
    const path = '~/workspace/projects/company-profile/work/agent-first-tower-prototype-v2/index.html';
    const onFileClick = vi.fn();

    render(<RichContent text={`결과: \`${path}\``} onFileClick={onFileClick} />);

    const link = screen.getByRole('button', { name: `Open file: ${path}` });
    expect(link).toHaveTextContent(path);
    fireEvent.click(link);
    expect(onFileClick).toHaveBeenCalledWith(path);
  });

  it('hides inline actions and shows the full file action set in the right-click menu', () => {
    const path = '~/workspace/projects/company-profile/work/brief.md';
    const onFileClick = vi.fn();

    render(<RichContent text={`결과: ${path}`} onFileClick={onFileClick} />);

    expect(screen.queryByText('열기')).not.toBeInTheDocument();
    expect(screen.queryByText('새 탭')).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByText(path));

    expect(screen.getByRole('menuitem', { name: 'Open in new tab' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Download' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Save to My Files' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Copy file path' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Show file location' })).toBeInTheDocument();
  });

  it('opens a plain workspace file path inside a tight Markdown list item', () => {
    const path = '~/workspace/projects/tower-project-dev/final/report.pdf';
    const onFileClick = vi.fn();

    render(<RichContent text={`결과물:\n- ${path}`} onFileClick={onFileClick} />);

    const link = screen.getByText(path);
    expect(link.closest('li')).not.toBeNull();
    expect(link).toHaveClass('cursor-pointer', 'underline');
    fireEvent.click(link);
    expect(onFileClick).toHaveBeenCalledWith(path);
  });
});

describe('RichContent code block wrapping', () => {
  it('wraps code block text on mobile instead of forcing transcript-wide horizontal scroll', () => {
    const longLine = `https://tower.tower.example.com/s/${'09fa1221-d8e3-4ae6-be77-a90aaa9e54f8'.repeat(2)}`;

    const { container } = render(<RichContent text={`\`\`\`text\n${longLine}\n\`\`\``} />);

    const pre = container.querySelector('pre');
    const code = container.querySelector('pre code');
    expect(pre).toHaveClass('max-w-full', 'overflow-x-hidden', 'whitespace-pre-wrap', 'break-words', 'md:overflow-x-auto');
    expect(code).toHaveClass('whitespace-pre-wrap', 'break-words', 'md:whitespace-pre');
    expect(code).toHaveTextContent(longLine);
  });
});

describe('RichContent URL links', () => {
  it('renders a bare Tower session URL visibly as a body link', () => {
    const url = 'https://tower.tower.example.com/s/09fa1221-d8e3-4ae6-be77-a90aaa9e54f8';

    render(<RichContent text={`참고 세션: ${url}`} />);

    const link = screen.getByRole('link', { name: url });
    expect(link).toHaveAttribute('href', url);
    expect(link).toHaveTextContent(url);
  });
});

describe('RichContent plain JSON rendering', () => {
  it('renders a pure JSON object as a preformatted block so indentation is preserved', () => {
    const json = '{\n  "todos": [\n    "write tests",\n    "ship fix"\n  ]\n}';

    render(<RichContent text={json} />);

    const block = screen.getByLabelText(i18n.t('jsonResponse', { ns: 'chat', defaultValue: 'JSON 응답' }));
    expect(block.tagName).toBe('PRE');
    expect(block).toHaveClass('whitespace-pre-wrap');
    expect(block.textContent).toContain('\n  "todos"');
    expect(block.textContent).toContain('\n    "write tests"');
  });

  it('continues to render ordinary markdown through the markdown renderer', () => {
    render(<RichContent text={'**not json**'} />);

    expect(screen.queryByLabelText(i18n.t('jsonResponse', { ns: 'chat', defaultValue: 'JSON 응답' }))).toBeNull();
    expect(screen.getByText('not json').tagName).toBe('STRONG');
  });
});
