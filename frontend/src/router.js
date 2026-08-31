// frontend/src/router.js

import { useEffect, useState } from 'react';

/**
 * Four routes do not justify a routing dependency. Hash routing also means the
 * static build works on Cloudflare Pages without any rewrite rules.
 *
 * @returns {{ path: string, params: string[] }}
 */
export function useRoute() {
  const [hash, setHash] = useState(() => window.location.hash || '#/');

  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const segments = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { path: segments[0] ?? '', params: segments.slice(1) };
}

/** @param {string} to */
export function navigate(to) {
  window.location.hash = to;
}
