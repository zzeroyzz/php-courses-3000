import type { SupabaseClient } from '@supabase/supabase-js';
import * as db from './db';

// Starts (or resumes) generation for a lesson, from the browser.
//
// The run id is stamped on the lesson row BEFORE the route is called, so a
// Stop pressed even before the server picks the request up still lands on
// this run. The route is fired without awaiting: generation can outlast a
// request, and the UI follows progress by watching the lessons row.
//
//   reset: true  — full restart; deletes earlier cards and questions
//   chunkFrom    — resume point after a failure or a stop-and-keep
export async function startGeneration(
  supabase: SupabaseClient,
  lessonId: string,
  opts: { reset: boolean; chunkFrom?: number }
): Promise<boolean> {
  const runId = await db.queueGeneration(supabase, lessonId, opts.reset);
  if (!runId) return false;
  fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lessonId, runId, chunkFrom: opts.reset ? 0 : opts.chunkFrom ?? 0 }),
  }).catch(() => {});
  return true;
}
