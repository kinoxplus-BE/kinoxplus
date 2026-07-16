/**
 * Canonical genre names — must match the chips in the signup wizard
 * (step 2) and the catalog's Genre rows. Stored on User.preferredGenres
 * as plain strings so registration never depends on catalog seeding.
 */
export const GENRES = [
  'Action',
  'Adventure',
  'Animation',
  'Anime',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Family',
  'Fantasy',
  'History',
  'Horror',
  'Music',
  'Mystery',
  'Romance',
  'Sci-Fi',
  'Thriller',
  'War',
  'Western',
] as const;

export type GenreName = (typeof GENRES)[number];
