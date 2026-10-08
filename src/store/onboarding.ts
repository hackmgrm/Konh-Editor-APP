/**
 * One-time onboarding hints.
 *
 * Each hint is a single flag in the app config (not the workspace: having
 * learned where the theme lives is a fact about the person, and it should not
 * reset because they opened another folder).
 */

import { useCallback, useEffect, useState } from 'react';
import { getConfig, setConfig } from './appConfig';

const TYPESET_HINT_KEY = 'onboarding.typesetHint';
/** Long enough for the workspace to have settled in front of the eye first */
const TYPESET_HINT_DELAY_MS = 1200;

/**
 * The 「在这里换排版主题」 callout under the preview's theme capsule.
 *
 * `eligible` is whatever the caller knows about the moment (preview visible,
 * studio closed, a draft open); the hook adds the delay and the persisted
 * flag. `dismiss` is safe to call any number of times, whether or not the
 * hint ever showed — finding the popover on your own counts as having seen it.
 */
export function useTypesetHint(eligible: boolean): { show: boolean; dismiss: () => void } {
  const [seen, setSeen] = useState(() => getConfig(TYPESET_HINT_KEY) === 'seen');
  // Counted from mount, i.e. from the moment the workspace is up
  const [due, setDue] = useState(false);

  useEffect(() => {
    if (seen) return;
    const t = window.setTimeout(() => setDue(true), TYPESET_HINT_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [seen]);

  const dismiss = useCallback(() => {
    if (getConfig(TYPESET_HINT_KEY) !== 'seen') setConfig(TYPESET_HINT_KEY, 'seen');
    setSeen(true);
  }, []);

  return { show: !seen && due && eligible, dismiss };
}
