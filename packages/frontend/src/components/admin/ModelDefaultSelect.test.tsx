// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelDefaultSelect } from './ModelDefaultSelect';
afterEach(cleanup);
const options = [{ value: 'glm', label: 'GLM' }, { value: 'deepseek', label: 'DeepSeek' }];
describe('persisted model selection', () => {
  it('never substitutes GLM for a stored mini absent from the catalog', () => {
    const onChange = vi.fn();
    render(<ModelDefaultSelect value="mini" options={options} ready label="Lite" missingLabel="mini — not listed" onChange={onChange} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('mini');
    expect(select.selectedOptions[0].textContent).toBe('mini — not listed');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: 'deepseek' } });
    expect(onChange).toHaveBeenCalledWith('deepseek');
  });
  it('locks loading and failure states and updates when catalog arrives', () => {
    const onChange = vi.fn();
    const props = { value: 'sol', label: 'Core', missingLabel: 'sol — pending', onChange };
    const view = render(<ModelDefaultSelect {...props} options={[]} ready={false} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe('sol');
    view.rerender(<ModelDefaultSelect {...props} options={[...options, { value: 'sol', label: 'Sol' }]} ready />);
    expect(select.disabled).toBe(false);
    expect(select.value).toBe('sol');
    expect(onChange).not.toHaveBeenCalled();
  });
  it('keeps unset settings explicit rather than showing the first option', () => {
    render(<ModelDefaultSelect value="" options={options} ready label="Core" missingLabel="Not configured" onChange={vi.fn()} />);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
  });
});
