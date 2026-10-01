import type { Section, SectionStats } from './db-types';

// How much of a chapter the user has demonstrated, 0–1:
//   accuracy  — correct ÷ answered in this chapter (not a global accuracy;
//               80% on Chapter 1 says nothing about Chapter 20)
//   coverage  — lessons answered in ÷ lessons that count toward progress
// A chapter with no answers contributes 0, so the bar can't run ahead of
// what has actually been practised.
export function chapterMastery(stats: SectionStats | undefined, countableLessons: number): number {
  if (!stats || stats.answered === 0 || countableLessons === 0) return 0;
  const accuracy = stats.correct / stats.answered;
  const coverage = Math.min(stats.lessons_attempted / countableLessons, 1);
  return accuracy * coverage;
}

// Weighted by sections.exam_weight and normalised, so hand-edited weights that
// don't sum exactly to 1 still produce a percentage.
export function weightedProgress(rows: { section: Section; mastery: number }[]): number {
  const total = rows.reduce((s, r) => s + r.section.exam_weight, 0);
  if (total <= 0) return 0;
  return rows.reduce((s, r) => s + r.section.exam_weight * r.mastery, 0) / total;
}

export function accuracyOf(stats: SectionStats | undefined): number | null {
  return stats && stats.answered > 0 ? stats.correct / stats.answered : null;
}
