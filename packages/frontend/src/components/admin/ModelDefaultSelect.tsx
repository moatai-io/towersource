interface Props {
  value: string;
  options: Array<{ value: string; label: string }>;
  ready: boolean;
  disabled?: boolean;
  label: string;
  missingLabel: string;
  onChange: (value: string) => void;
}

/** Always represent the persisted value, even when discovery excludes it. */
export function ModelDefaultSelect({ value, options, ready, disabled, label, missingLabel, onChange }: Props) {
  const represented = options.some(option => option.value === value);
  return (
    <select aria-label={label} value={value} disabled={disabled || !ready}
      onChange={event => {
        const next = event.target.value;
        if (ready && !disabled && options.some(option => option.value === next)) onChange(next);
      }}
      className="min-h-10 w-full rounded-md border border-surface-600 bg-surface-700 px-3 text-[14px] text-gray-200 sm:w-[240px]">
      {!represented && <option value={value} disabled>{missingLabel}</option>}
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}
