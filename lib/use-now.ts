'use client';

import { useEffect, useState } from 'react';

// Current time, re-read every `intervalMs` while `active`. contentStatus()
// depends on how old the heartbeat is, so a page showing a running generation
// needs to re-evaluate it periodically to notice a run that has gone silent.
export function useNow(active: boolean, intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}
