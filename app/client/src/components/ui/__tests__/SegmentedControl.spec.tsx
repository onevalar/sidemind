import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import SegmentedControl from '../SegmentedControl';

it('keeps the selected view and keyboard focus together, including wraparound and Home/End', async () => {
  function Views() {
    const [value, setValue] = useState('canvas');
    return (
      <SegmentedControl
        label="View"
        value={value}
        onValueChange={setValue}
        options={[
          { value: 'chat', label: 'Chat' },
          { value: 'canvas', label: 'Canvas' },
          { value: 'reader', label: 'Reader' },
        ]}
      />
    );
  }
  const user = userEvent.setup();
  render(<Views />);
  await user.tab();
  expect(screen.getByRole('button', { name: 'Canvas' })).toHaveFocus();
  for (const [key, label] of [
    ['{ArrowRight}', 'Reader'],
    ['{ArrowRight}', 'Chat'],
    ['{End}', 'Reader'],
    ['{ArrowLeft}', 'Canvas'],
    ['{Home}', 'Chat'],
    ['{ArrowLeft}', 'Reader'],
  ]) {
    await user.keyboard(key);
    const selected = screen.getByRole('button', { name: label });
    expect(selected).toHaveFocus();
    expect(selected).toHaveAttribute('aria-pressed', 'true');
    expect(selected).toHaveAttribute('tabindex', '0');
    for (const other of screen.getAllByRole('button').filter((button) => button !== selected)) {
      expect(other).toHaveAttribute('aria-pressed', 'false');
      expect(other).toHaveAttribute('tabindex', '-1');
    }
  }
  await user.click(screen.getByRole('button', { name: 'Canvas' }));
  expect(screen.getByRole('button', { name: 'Canvas' })).toHaveAttribute('aria-pressed', 'true');
});
