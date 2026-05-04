export type ResultSource = 'search_result' | 'suggested';

export interface ResultRow {
  title: string;
  link: string;
  url: string;
  niche: string;
  matchScore: number;
  step: number;
  source: ResultSource;
}

export interface VideoLink {
  title: string;
  url: string;
}
