// Everything course-specific lives here. Swapping the course means editing this
// file and reseeding sections/lessons — no other code names the course.

export const APP_NAME = 'GA Real Estate Study';

export const COURSE_NAME = 'Georgia Real Estate Licensing Course';

// Used in the generation prompts.
export const COURSE_CONTEXT =
  'the Georgia real estate salesperson pre-license course, preparing for the Georgia real estate salesperson licensing exam';

// Shown on the dashboard progress bar. sections.exam_weight currently holds
// course-completion weights (each chapter's share of the course's lessons), so
// the bar measures course progress, not a projected exam score. If real exam
// content-outline weights are loaded into exam_weight, change this label.
export const PROGRESS_LABEL = 'Course progress';
