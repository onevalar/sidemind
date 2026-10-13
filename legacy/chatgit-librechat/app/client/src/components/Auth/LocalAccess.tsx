import { useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { TLoginLayoutContext } from '~/common';
import { useLocalize } from '~/hooks';

/** The launcher command; a literal the user types, so it is not translated. */
const OPEN_COMMAND = 'npm run open';

/**
 * Shown instead of any sign-in or sign-up form when ChatGit runs in account-free local mode and
 * this browser has no session. Entry only happens through the device-local launcher, which hands
 * the browser a single-use ticket, so the screen explains how to get one rather than asking for
 * credentials.
 */
export default function LocalAccess() {
  const localize = useLocalize();
  const { setHeaderText } = useOutletContext<TLoginLayoutContext>();

  useEffect(() => {
    setHeaderText('com_auth_local_title');
  }, [setHeaderText]);

  return (
    <section className="text-text-primary flex flex-col gap-4 text-center text-sm">
      <p className="text-text-secondary">{localize('com_auth_local_description')}</p>
      <p>
        <code className="bg-surface-secondary border-border-light inline-block rounded-lg border px-3 py-2 font-mono text-base">
          {OPEN_COMMAND}
        </code>
      </p>
      <p className="text-text-secondary">{localize('com_auth_local_hint')}</p>
    </section>
  );
}
