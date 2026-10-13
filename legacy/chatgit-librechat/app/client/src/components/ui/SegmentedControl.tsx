// Adapted from Arc UI's MIT segmented-control. See app/ARC_UI.md.
import { useId, useRef } from 'react';
import { LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import type { KeyboardEvent, ReactNode } from 'react';
import { cn } from '~/utils';

type Segment = { value: string; label: string; icon?: ReactNode };

/** Controlled view selection; changing the view never owns or resets its data. */
export default function SegmentedControl({
  options,
  value,
  onValueChange,
  label,
}: {
  options: Segment[];
  value: string;
  onValueChange: (value: string) => void;
  label: string;
}) {
  const id = useId();
  const reduced = useReducedMotion();
  const track = useRef<HTMLDivElement>(null);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const last = options.length - 1;
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    let target = -1;
    if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = last;
    else if (event.key === 'ArrowDown' || event.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) {
      target = selectedIndex === last ? 0 : selectedIndex + 1;
    } else if (event.key === 'ArrowUp' || event.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) {
      target = selectedIndex === 0 ? last : selectedIndex - 1;
    }
    const option = options[target];
    if (!option) return;
    event.preventDefault();
    onValueChange(option.value);
    track.current?.querySelectorAll('button')[target]?.focus({ preventScroll: true });
  }

  return (
    <div
      role="group"
      aria-label={label}
      className="border-border-light bg-surface-secondary inline-flex max-w-full min-w-0 rounded-xl border p-1"
    >
      <LayoutGroup id={id}>
        <div ref={track} className="isolate flex min-w-0 gap-1 overflow-x-auto">
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={value === option.value}
              tabIndex={index === selectedIndex ? 0 : -1}
              onClick={() => onValueChange(option.value)}
              onKeyDown={onKeyDown}
              className={cn(
                'focus-visible:outline-focus-control relative min-h-11 shrink-0 rounded-lg px-3 text-sm font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:-outline-offset-2',
                value === option.value ? 'text-text-primary' : 'text-text-secondary',
              )}
            >
              {value === option.value && (
                <motion.span
                  aria-hidden="true"
                  layoutId="selection"
                  layoutDependency={value}
                  transition={
                    reduced ? { duration: 0 } : { type: 'spring', duration: 0.2, bounce: 0 }
                  }
                  className="border-border-light bg-surface-primary absolute inset-0 -z-10 rounded-lg border shadow-xs"
                />
              )}
              <span className="inline-flex items-center gap-2">
                {option.icon}
                {option.label}
              </span>
            </button>
          ))}
        </div>
      </LayoutGroup>
    </div>
  );
}
