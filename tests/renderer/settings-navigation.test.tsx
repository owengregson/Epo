/** @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 */
import { fireEvent, render, screen, within } from '@testing-library/preact';
import { GALLERY_SETTINGS_VIEW } from '@/renderer/gallery/settings-fixture';
import { SectionRail } from '@/renderer/settings/SectionRail';
import { RadioCards } from '@/renderer/ui/RadioCards';
import type { SectionId } from '@/shared/settings-params';

describe('Settings section navigation', () => {
  const sections: readonly SectionId[] = ['pace', 'schedule', 'app', 'timing', 'technical'];

  it('offers the same destinations through a native selector and plain navigation rows', () => {
    const pick = jest.fn();
    render(<SectionRail view={GALLERY_SETTINGS_VIEW} sections={sections} active="pace" onPick={pick} />);
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const selector = within(nav).getByRole('combobox', { name: 'Jump to section' });
    expect(within(selector).getAllByRole('option').map((option) => (option as HTMLOptionElement).value)).toEqual(sections);
    expect(within(selector).getByRole('group', { name: 'Advanced' })).toBeTruthy();
    fireEvent.change(selector, { target: { value: 'technical' } });
    expect(pick).toHaveBeenLastCalledWith('technical');
    const schedule = within(nav).getByRole('button', { name: 'When Epo works' });
    expect(schedule.getAttribute('aria-controls')).toBe('settings-schedule');
    fireEvent.click(schedule);
    expect(pick).toHaveBeenLastCalledWith('schedule');
  });

  it('keeps the selector and current-row announcement synchronized with the scrolled section', () => {
    const props = { view: GALLERY_SETTINGS_VIEW, sections, onPick: jest.fn() };
    const rendered = render(<SectionRail {...props} active="pace" />);
    const selector = screen.getByRole('combobox', { name: 'Jump to section' }) as HTMLSelectElement;
    expect(selector.value).toBe('pace');
    rendered.rerender(<SectionRail {...props} active="timing" />);
    expect(selector.value).toBe('timing');
    expect(screen.getByRole('button', { name: 'Timing' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'Growth pace' }).hasAttribute('aria-current')).toBe(false);
  });
});

describe('compact Settings choice cards', () => {
  it('announces selection and recommendation without an extra selected sentence, and retains arrow-key choice', () => {
    const pick = jest.fn();
    const choices = [
      { value: 'gentle', title: 'Gentle', metric: 'About 26 a day', line: 'Light and relaxed.' },
      { value: 'balanced', title: 'Balanced', metric: 'About 44 a day', line: 'Steady growth.', recommended: true },
      { value: 'faster', title: 'Faster', metric: 'About 66 a day', line: 'More new people.' },
    ];
    render(<RadioCards label="Growth pace" choices={choices} selected="balanced" onSelect={pick} />);
    const selected = screen.getByRole('radio', { name: /Balanced.*Recommended/ });
    expect(selected.getAttribute('aria-checked')).toBe('true');
    expect(selected.tabIndex).toBe(0);
    expect(screen.queryByText('Selected')).toBeNull();
    selected.focus();
    fireEvent.keyDown(selected, { key: 'ArrowRight' });
    expect(pick).toHaveBeenCalledWith('faster');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /Faster/ }));
  });
});
