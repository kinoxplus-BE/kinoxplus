import type { GenreName } from '../common/constants/genres';

export interface PublicDomainArchiveTitle {
  identifier: string;
  name: string;
  year: number;
  genres: readonly GenreName[];
  description: string;
  rightsNote: string;
  rightsSourceUrls: readonly string[];
  preferredFileNames?: readonly string[];
  includeByDefault?: boolean;
  requiresLegalReview?: boolean;
}

/**
 * Curated starter catalog. Do not turn this into an open crawler without a
 * rights review step: Archive metadata is useful, but rights are item-specific.
 */
export const PUBLIC_DOMAIN_ARCHIVE_TITLES: readonly PublicDomainArchiveTitle[] = [
  {
    identifier: 'sherlockjr1924_201909',
    name: 'Sherlock Jr.',
    year: 1924,
    genres: ['Comedy', 'Family'],
    description:
      'A film projectionist dreams himself into the movie screen as a great detective in Buster Keaton\'s silent comedy classic.',
    rightsNote:
      'Public domain in the United States; Wikimedia Commons cites publication before January 1, 1931.',
    rightsSourceUrls: [
      'https://commons.wikimedia.org/wiki/File:Sherlock_Jr._-_Buster_Keaton_(1924)_HD_(720p).ogv',
      'https://archive.org/details/sherlockjr1924_201909',
    ],
    includeByDefault: true,
  },
  {
    identifier: 'steamboat-bill-jr_1928',
    name: 'Steamboat Bill Jr.',
    year: 1928,
    genres: ['Comedy', 'Family'],
    description:
      'Buster Keaton plays the gentle son of a steamboat captain who tries to prove himself on the river.',
    rightsNote:
      'Public domain in the United States; Wikimedia Commons structured data marks the film public domain.',
    rightsSourceUrls: [
      'https://commons.wikimedia.org/wiki/File:Steamboat_Bill_Jr._(1928).webm',
      'https://archive.org/details/steamboat-bill-jr_1928',
    ],
    includeByDefault: true,
  },
  {
    identifier: 'the-navigator',
    name: 'The Navigator',
    year: 1924,
    genres: ['Comedy', 'Adventure'],
    description:
      'Two pampered young people accidentally drift to sea alone on a massive ocean liner in this Buster Keaton feature.',
    rightsNote:
      'Public domain in the United States; Wikimedia Commons category lists the film among public-domain films.',
    rightsSourceUrls: [
      'https://commons.wikimedia.org/wiki/Category:The_Navigator_(1924_film)',
      'https://archive.org/details/the-navigator',
    ],
    includeByDefault: true,
  },
  {
    identifier: 'safety-last-1923-by-fred-c.-newmeyer-and-sam-taylor',
    name: 'Safety Last!',
    year: 1923,
    genres: ['Comedy', 'Family'],
    description:
      'Harold Lloyd climbs toward one of silent cinema\'s most famous clock-tower images in this energetic comedy.',
    rightsNote:
      'Public domain in the United States; Wikimedia Commons notes the film entered the public domain on January 1, 2019.',
    rightsSourceUrls: [
      'https://commons.wikimedia.org/wiki/File:Safety_Last!_(1923)_by_Fred_C._Newmeyer.webm',
      'https://archive.org/details/safety-last-1923-by-fred-c.-newmeyer-and-sam-taylor',
    ],
    includeByDefault: false,
    requiresLegalReview: true,
  },
  {
    identifier: 'gullivers_travels1939',
    name: "Gulliver's Travels",
    year: 1939,
    genres: ['Animation', 'Family', 'Adventure'],
    description:
      'Fleischer Studios adapts Jonathan Swift\'s tale into a colorful animated feature about Gulliver in Lilliput.',
    rightsNote:
      'Public Domain Review labels the underlying work PD U.S.; Wikimedia Commons notes copyright was not renewed.',
    rightsSourceUrls: [
      'https://publicdomainreview.org/collection/gulliver-s-travels-1939/',
      'https://commons.wikimedia.org/wiki/Category:Gulliver%27s_Travels_(1939_film)',
      'https://archive.org/details/gullivers_travels1939',
    ],
    includeByDefault: true,
  },
  {
    identifier: 'royal_wedding',
    name: 'Royal Wedding',
    year: 1951,
    genres: ['Comedy', 'Music', 'Romance'],
    description:
      'Fred Astaire and Jane Powell play a brother-sister dance act whose London trip turns into romance and show business sparkle.',
    rightsNote:
      'Public-domain/not-renewed notes exist on Wikimedia Commons for source screenshots; keep the item in the reviewed POC bucket.',
    rightsSourceUrls: [
      'https://commons.wikimedia.org/wiki/Category:Royal_Wedding',
      'https://archive.org/details/royal_wedding',
    ],
    includeByDefault: true,
  },
  {
    identifier: 'Sita_Sings_the_Blues',
    name: 'Sita Sings the Blues',
    year: 2008,
    genres: ['Animation', 'Music', 'Comedy'],
    description:
      'Nina Paley blends the Ramayana, personal heartbreak, and 1920s jazz vocals into a playful animated feature.',
    rightsNote:
      'Open-license/CC0 public-domain dedication on the Archive metadata and creator site; retain attribution notes.',
    rightsSourceUrls: [
      'https://www.sitasingstheblues.com/watch.html',
      'https://archive.org/details/Sita_Sings_the_Blues',
    ],
    preferredFileNames: [
      'Sita_Sings_the_Blues.mp4',
      'SITA_SINGS_MOVIE_ONLY.mp4',
    ],
    includeByDefault: true,
  },
  {
    identifier: 'MeetJohnDoeHD',
    name: 'Meet John Doe',
    year: 1941,
    genres: ['Drama', 'Comedy'],
    description:
      'Frank Capra directs Gary Cooper and Barbara Stanwyck in a sharp comedy-drama about a newspaper campaign that becomes a movement.',
    rightsNote:
      'Public Domain Review labels the underlying work PD U.S.; keep source-copy rights under review.',
    rightsSourceUrls: [
      'https://publicdomainreview.org/collection/meet-john-doe-1941',
      'https://archive.org/details/MeetJohnDoeHD',
    ],
    includeByDefault: true,
  },
  {
    identifier: 'charade_1963',
    name: 'Charade',
    year: 1963,
    genres: ['Mystery', 'Romance', 'Comedy'],
    description:
      'Audrey Hepburn and Cary Grant star in a stylish romantic mystery set around mistaken identities and hidden money.',
    rightsNote:
      'Often treated as public domain in the United States due to notice defects, but commercial/international use should be reviewed before seeding.',
    rightsSourceUrls: [
      'https://commons.wikimedia.org/wiki/File:Charade_(1963).webm',
      'https://archive.org/details/charade_1963',
    ],
    includeByDefault: false,
    requiresLegalReview: true,
  },
];
