export interface ContentSafetyInput {
  adult?: boolean | null;
  title?: string | null;
  originalTitle?: string | null;
  description?: string | null;
  overview?: string | null;
}

export const UNSAFE_CATALOG_CONTAINS_TERMS = [
  'sex',
  'erotic',
  'porn',
  'xxx',
  'nude',
  'naked',
  'orgy',
  'brothel',
  'prostitut',
  'stripper',
  'playboy',
] as const;

const UNSAFE_CONTENT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'TMDB adult flag', pattern: /\b__adult_flag__\b/i },
  { label: 'sexually explicit wording', pattern: /\bsex(?:ual|y)?\b/i },
  { label: 'erotic wording', pattern: /\berotic\w*\b/i },
  { label: 'pornographic wording', pattern: /\bporn\w*\b/i },
  { label: 'nudity wording', pattern: /\bnud(?:e|ity)\b/i },
  { label: 'nudity wording', pattern: /\bnaked\b/i },
  { label: 'adult-content marker', pattern: /\bxxx\b/i },
  { label: 'sexual-content wording', pattern: /\borgy\b/i },
  { label: 'sexual-content wording', pattern: /\bbrothel\b/i },
  { label: 'sexual-content wording', pattern: /\bprostitut(?:e|ion)\b/i },
  { label: 'sexual-content wording', pattern: /\bstripper\b/i },
  { label: 'sexual-content wording', pattern: /\bplayboy\b/i },
  { label: 'sexual-violence wording', pattern: /\brap(?:e|ed|ist)\b/i },
  { label: 'abuse wording', pattern: /\bmolest\w*\b/i },
  { label: 'incest wording', pattern: /\bincest\w*\b/i },
];

export function unsafeContentReason(input: ContentSafetyInput): string | null {
  const text = [
    input.adult ? '__adult_flag__' : '',
    input.title,
    input.originalTitle,
    input.description,
    input.overview,
  ]
    .filter(Boolean)
    .join(' ');

  for (const { label, pattern } of UNSAFE_CONTENT_PATTERNS) {
    if (pattern.test(text)) return label;
  }

  return null;
}

export function isUnsafeContent(input: ContentSafetyInput): boolean {
  return unsafeContentReason(input) !== null;
}
