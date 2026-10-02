import type { Profile, DBachievement } from './db-types';

// ── XP & Levels ───────────────────────────────────────────────────────────────

// Cumulative XP required to reach each level (index = level - 1)
const LEVEL_THRESHOLDS = [0, 50, 150, 300, 500, 750, 1100, 1500, 2000, 2600, 3300];

export type LevelInfo = {
  level: number;
  xpInLevel: number;
  xpForNextLevel: number;
  progress: number; // 0-1
};

export function getLevelInfo(xp: number): LevelInfo {
  let level = 1;
  for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
    if (xp >= LEVEL_THRESHOLDS[i]) level = i + 1;
    else break;
  }
  const prevThreshold = LEVEL_THRESHOLDS[Math.min(level - 1, LEVEL_THRESHOLDS.length - 1)];
  const nextThreshold = LEVEL_THRESHOLDS[Math.min(level, LEVEL_THRESHOLDS.length - 1)];
  const xpInLevel = xp - prevThreshold;
  const range = nextThreshold - prevThreshold;
  return {
    level,
    xpInLevel,
    xpForNextLevel: nextThreshold,
    progress: range > 0 ? Math.min(xpInLevel / range, 1) : 1,
  };
}

export const XP_CARD_REVIEW = 2;
export const XP_CARD_CORRECT_BONUS = 3;
export const XP_QUESTION_ANSWERED = 2;
export const XP_QUESTION_CORRECT_BONUS = 5;

// ── Streak ────────────────────────────────────────────────────────────────────

export function computeNewStreak(profile: Profile): {
  current_streak: number;
  longest_streak: number;
  last_active_date: string;
} {
  const today = new Date().toISOString().slice(0, 10);
  if (profile.last_active_date === today) {
    // Already updated today
    return {
      current_streak: profile.current_streak,
      longest_streak: profile.longest_streak,
      last_active_date: today,
    };
  }

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const isConsecutive = profile.last_active_date === yesterday;
  const newStreak = isConsecutive ? profile.current_streak + 1 : 1;
  const newLongest = Math.max(newStreak, profile.longest_streak);

  return { current_streak: newStreak, longest_streak: newLongest, last_active_date: today };
}


// ── Achievements ──────────────────────────────────────────────────────────────

export type AchievementDef = {
  id: string;
  title: string;
  description: string;
  icon: string;
};

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first_card',    title: 'First Flip',     description: 'Review your first flashcard',    icon: '🃏' },
  { id: 'cards_10',      title: 'Getting Started', description: 'Review 10 flashcards',           icon: '📚' },
  { id: 'cards_50',      title: 'Half Century',    description: 'Review 50 flashcards',           icon: '🎯' },
  { id: 'cards_100',     title: 'Card Shark',      description: 'Review 100 flashcards total',    icon: '🦈' },
  { id: 'first_quiz',    title: 'Quiz Taker',      description: 'Complete your first quiz',       icon: '📝' },
  { id: 'perfect_quiz',  title: 'Perfect Score',   description: 'Get 100% on a quiz',             icon: '⭐' },
  { id: 'streak_3',      title: 'On a Roll',       description: 'Study 3 days in a row',          icon: '🔥' },
  { id: 'streak_7',      title: 'Week Warrior',    description: 'Study 7 days in a row',          icon: '🏆' },
  { id: 'streak_14',     title: 'Cram King',       description: 'Study 14 days in a row',         icon: '👑' },
  { id: 'first_lesson',  title: 'Reader',          description: 'Complete your first lesson',     icon: '📖' },
  { id: 'module_master', title: 'Module Master',   description: 'Reach 80% mastery in a module', icon: '🎓' },
  { id: 'daily_goal',    title: 'Goal Crusher',    description: 'Hit your daily card goal',       icon: '💪' },
  { id: 'level_5',       title: 'Rising Star',     description: 'Reach level 5',                  icon: '⚡' },
  { id: 'level_10',      title: 'Course Expert',   description: 'Reach level 10',                 icon: '🎖️' },
];

export type AchievementCheckContext = {
  totalCardsEverReviewed: number;
  quizScore?: number;
  quizTotal?: number;
  mastery?: number;
  lessonsRead: number;
  streak: number;
  level: number;
  dailyCardCount: number;
  dailyGoal: number;
};

export function findNewAchievements(
  existing: DBachievement[],
  ctx: AchievementCheckContext
): string[] {
  const earned = new Set(existing.map((a) => a.achievement_id));
  const newOnes: string[] = [];

  const check = (id: string, condition: boolean) => {
    if (!earned.has(id) && condition) newOnes.push(id);
  };

  check('first_card',    ctx.totalCardsEverReviewed >= 1);
  check('cards_10',      ctx.totalCardsEverReviewed >= 10);
  check('cards_50',      ctx.totalCardsEverReviewed >= 50);
  check('cards_100',     ctx.totalCardsEverReviewed >= 100);
  check('first_quiz',    ctx.quizTotal !== undefined && ctx.quizTotal > 0);
  check('perfect_quiz',  ctx.quizScore !== undefined && ctx.quizTotal !== undefined && ctx.quizScore === ctx.quizTotal && ctx.quizTotal > 0);
  check('streak_3',      ctx.streak >= 3);
  check('streak_7',      ctx.streak >= 7);
  check('streak_14',     ctx.streak >= 14);
  check('first_lesson',  ctx.lessonsRead >= 1);
  check('module_master', ctx.mastery !== undefined && ctx.mastery >= 80);
  check('daily_goal',    ctx.dailyCardCount >= ctx.dailyGoal);
  check('level_5',       ctx.level >= 5);
  check('level_10',      ctx.level >= 10);

  return newOnes;
}
