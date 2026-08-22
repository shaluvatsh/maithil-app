import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from '@/components/modal';

/**
 * Every real caller passes `onClose` as an inline arrow function - the natural
 * way to write it. `Modal`'s focus-management effect used to depend on
 * `[onClose]` directly, so a NEW `onClose` identity on every render (which
 * typing into any input inside the modal causes, since it re-renders the
 * caller) tore the effect down and re-ran it on every keystroke - and the
 * cleanup phase moves focus away from whatever is currently focused. A
 * purohit typing a cancellation reason lost the cursor after the first
 * character, every time. This renders a controlled input inside the modal
 * exactly the way every real caller does (inline `onClose`) and types more
 * than one character, so a regression fails here instead of only in the app.
 */
describe('Modal', () => {
  function HostWithControlledInput() {
    const [open, setOpen] = useState(true);
    const [value, setValue] = useState('');
    if (!open) return null;
    return (
      <Modal title="Reason" onClose={() => setOpen(false)}>
        <input aria-label="reason" value={value} onChange={(e) => setValue(e.target.value)} />
      </Modal>
    );
  }

  it('keeps focus in a controlled input while typing, across multiple keystrokes', async () => {
    const user = userEvent.setup();
    render(<HostWithControlledInput />);

    const input = screen.getByLabelText('reason');
    await user.click(input);
    await user.type(input, 'A funeral');

    expect(input).toHaveValue('A funeral');
    expect(document.activeElement).toBe(input);
  });

  it('still closes on Escape', async () => {
    const user = userEvent.setup();
    render(<HostWithControlledInput />);

    await user.click(screen.getByLabelText('reason'));
    await user.keyboard('{Escape}');

    expect(screen.queryByLabelText('reason')).not.toBeInTheDocument();
  });
});
