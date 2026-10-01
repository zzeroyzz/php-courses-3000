import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@/utils/supabase/server';
import * as db from '@/lib/db';
import { COURSE_CONTEXT } from '@/lib/course';
import { GENERATION_MODEL, requireAdmin } from '@/lib/generation';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// The "Going deeper" reading layer: generated, explicitly unsourced, and shown
// beneath the lesson styled apart from the course text. It is stored in
// lessons.depth_content and never becomes flashcards or questions, so nothing
// here can enter spaced repetition (see the note in /api/generate).
//
// Triggered on demand by an admin after the source has been read — never on
// paste. Refused for chapters with allow_generated_depth = false (the Georgia
// statute chapters), whose depth comes from pasted primary sources instead.

const DEPTH_PROMPT = `You are writing an optional "Going deeper" reading section for a lesson in ${COURSE_CONTEXT}.

The student has already read the course text below. The course material is brief; your job is to deepen understanding of the same concepts:
- explain the reasoning behind the rules and why they exist
- give one or two concrete, realistic examples with named fictional people
- point out common misconceptions and how the concept connects to related topics

Hard limits:
- Do not state Georgia-specific law: no Georgia statute or Commission rule numbers, deadlines, fees, dollar amounts or time limits. Students verify those against primary sources, not this section. Stay with general, national real estate concepts.
- Do not contradict the course text. Where general practice varies, say so rather than picking one version.
- Do not repeat the course text back.

Format: plain text, 350–700 words. Short headings on their own line ending with a colon, paragraphs separated by blank lines, bullets starting with "- ". No markdown symbols other than those bullets.`;

export async function POST(request: NextRequest) {
  const { lessonId } = await request.json() as { lessonId?: string };
  if (!lessonId) return NextResponse.json({ error: 'lessonId required' }, { status: 400 });

  const supabase = await createClient();

  const auth = await requireAdmin(supabase);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const lesson = await db.getLessonById(supabase, lessonId);
  if (!lesson) return NextResponse.json({ error: 'Lesson not found' }, { status: 404 });
  const section = await db.getSectionById(supabase, lesson.section_id);
  if (!section) return NextResponse.json({ error: 'Section not found' }, { status: 404 });

  if (!section.allow_generated_depth) {
    return NextResponse.json(
      { error: 'This chapter covers Georgia law; add primary sources instead of generated depth.' },
      { status: 400 }
    );
  }
  if (!lesson.source_content.trim()) {
    return NextResponse.json({ error: 'Lesson has no source content' }, { status: 400 });
  }

  try {
    const message = await client.messages.create({
      model: GENERATION_MODEL,
      max_tokens: 4096,
      system: DEPTH_PROMPT,
      messages: [{ role: 'user', content: `Lesson: ${lesson.title}\n\nCourse text:\n${lesson.source_content}` }],
    });

    console.log(`[generate-depth] lesson=${lessonId} tokens: input=${message.usage.input_tokens} output=${message.usage.output_tokens}`);

    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (!text) throw new Error('Empty response from model');

    const ok = await db.updateLessonDepth(supabase, lessonId, text);
    if (!ok) throw new Error('Failed to save depth content');

    return NextResponse.json({ ok: true, depth_content: text });
  } catch (err) {
    console.error('[generate-depth] FAILED', err);
    const msg = err instanceof Error ? err.message : 'Generation failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
