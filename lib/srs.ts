import type { SrsState } from './db-types';

// SM-2 spaced repetition scheduling
// Based on the SuperMemo SM-2 algorithm with minor simplifications.
//
// Pure functions over one user's SrsState (card_progress). Cards are shared;
// scheduling is per user.

// Returns the updated SM-2 fields for a card after a review.
export function scheduleCard(
  card: Pick<SrsState, 'ease' | 'interval_days' | 'lapses'>,
  correct: boolean
): { ease: number; interval_days: number; due_at: Date; lapses: number } {
  let { ease, interval_days, lapses } = card;

  if (!correct) {
    lapses++;
    ease = Math.max(1.3, ease - 0.2);
    interval_days = 0;
    return { ease, interval_days, due_at: new Date(), lapses };
  }

  // Correct answer: advance interval
  if (interval_days === 0) {
    interval_days = 1;
  } else if (interval_days === 1) {
    interval_days = 6;
  } else {
    interval_days = Math.round(interval_days * ease);
  }

  ease = Math.max(1.3, ease + 0.1);

  const due_at = new Date();
  due_at.setDate(due_at.getDate() + interval_days);

  return { ease, interval_days, due_at, lapses };
}

// due_at null = never reviewed by this user. Inside a lesson that counts as due:
// studying the lesson is what introduces its cards.
export function isDue(card: Pick<SrsState, 'due_at'>): boolean {
  if (!card.due_at) return true;
  return new Date(card.due_at) <= new Date();
}

export function filterDue<T extends Pick<SrsState, 'due_at'>>(cards: T[]): T[] {
  return cards.filter(isDue);
}

export function daysUntilDue(card: Pick<SrsState, 'due_at'>): number {
  if (!card.due_at) return 0;
  const diff = new Date(card.due_at).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / 86400000));
}

export function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
