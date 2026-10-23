// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SelectField } from './ui';

afterEach(cleanup);

function setup(props: Partial<React.ComponentProps<typeof SelectField>> = {}) {
  const onChange = vi.fn();
  render(
    <SelectField label="Peran" hint="Pilih peran" value="b" onChange={onChange} {...props}>
      <option value="a">Admin</option>
      <option value="b">Barista</option>
      <option value="c">Cashier</option>
    </SelectField>,
  );
  const trigger = screen.getByRole('combobox', { name: /Peran/ });
  return { onChange, trigger };
}

const values = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls.map((c) => (c[0] as { target: { value: string } }).target.value);

describe('SelectField', () => {
  it('shows the initial value and is found by its label', () => {
    const { trigger } = setup();
    expect(screen.getByLabelText('Peran')).toBe(trigger);
    expect(trigger.textContent).toContain('Barista');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-describedby')).toContain('-hint');
    expect(document.getElementById(trigger.getAttribute('aria-describedby') ?? '')).not.toBeNull();
  });

  it('calls onChange exactly once when an option is clicked', () => {
    const { onChange, trigger } = setup();
    fireEvent.click(trigger);
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    fireEvent.click(screen.getByRole('option', { name: 'Cashier' }));
    expect(values(onChange)).toEqual(['c']);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does not call onChange when the current value is re-picked', () => {
    const { onChange, trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: 'Barista' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps a caller id on the trigger so the label stays linked', () => {
    const { trigger } = setup({ id: 'role-1' });
    expect(trigger.id).toBe('role-1');
    expect(document.querySelector('label')?.getAttribute('for')).toBe('role-1');
  });

  it('supports keyboard: arrows, Home/End, Enter, Escape and Tab', () => {
    const { onChange, trigger } = setup();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Barista' }).id,
    );
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Cashier' }).id,
    );
    fireEvent.keyDown(trigger, { key: 'Home' });
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Admin' }).id,
    );
    fireEvent.keyDown(trigger, { key: 'End' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(values(onChange)).toEqual(['c']);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.keyDown(trigger, { key: ' ' });
    fireEvent.keyDown(trigger, { key: 'Home' });
    fireEvent.keyDown(trigger, { key: ' ' });
    expect(values(onChange)).toEqual(['c', 'a']);

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    expect(onChange).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Tab' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('jumps to a matching option by typing a letter', () => {
    const { onChange, trigger } = setup();
    fireEvent.keyDown(trigger, { key: 'c' });
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Cashier' }).id,
    );
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(values(onChange)).toEqual(['c']);
  });

  it('closes on an outside click', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does not open when disabled', () => {
    const { onChange, trigger } = setup({ disabled: true });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
