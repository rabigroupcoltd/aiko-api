/**
 * Minna landmarks — the local gazetteer.
 *
 * Ported from the mobile app, where it shipped as a bundled JSON file so
 * address search worked with no network. Seeding it into `place_cache` moves
 * that job to the server: every client gets the same list, it stays warm
 * alongside anything the Places API returns, and search keeps working before
 * GOOGLE_MAPS_API_KEY is configured at all.
 *
 * `aliases` are the names locals actually type — "kasuwa" for the central
 * market, "keke park" for the motor park. They are folded into `searchText` at
 * seed time so a plain contains-match finds them.
 */

export interface MinnaLandmark {
  /** Stable id, reused as the placeId so re-seeding is idempotent. */
  id: string;
  name: string;
  aliases: string[];
  area: string;
  lat: number;
  lng: number;
  category:
    | 'landmark'
    | 'market'
    | 'campus'
    | 'hospital'
    | 'transport'
    | 'government'
    | 'residential';
}

export const MINNA_LANDMARKS: MinnaLandmark[] = [
  {
    id: 'mna-001',
    name: 'Mobil Roundabout',
    aliases: ['mobil', 'mobil junction', 'mobil round about'],
    area: 'Tunga',
    lat: 9.6091,
    lng: 6.5471,
    category: 'landmark',
  },
  {
    id: 'mna-002',
    name: 'Tunga Market',
    aliases: ['tunga', 'tunga mkt'],
    area: 'Tunga',
    lat: 9.6034,
    lng: 6.5502,
    category: 'market',
  },
  {
    id: 'mna-003',
    name: 'Minna Central Market',
    aliases: ['central market', 'kasuwa', 'main market'],
    area: 'Minna City Centre',
    lat: 9.6142,
    lng: 6.5563,
    category: 'market',
  },
  {
    id: 'mna-004',
    name: 'Kpakungu Roundabout',
    aliases: ['kpakungu', 'pakungu'],
    area: 'Kpakungu',
    lat: 9.5793,
    lng: 6.5321,
    category: 'landmark',
  },
  {
    id: 'mna-005',
    name: 'Bosso Town',
    aliases: ['bosso', 'boso'],
    area: 'Bosso',
    lat: 9.6479,
    lng: 6.5382,
    category: 'residential',
  },
  {
    id: 'mna-006',
    name: 'FUT Minna, Bosso Campus',
    aliases: ['fut bosso', 'futminna bosso', 'federal university of technology bosso'],
    area: 'Bosso',
    lat: 9.6497,
    lng: 6.5261,
    category: 'campus',
  },
  {
    id: 'mna-007',
    name: 'FUT Minna, Gidan Kwano Campus',
    aliases: ['fut gidan kwano', 'gidan kwano', 'futminna main campus', 'gidankwano'],
    area: 'Gidan Kwano',
    lat: 9.5312,
    lng: 6.4468,
    category: 'campus',
  },
  {
    id: 'mna-008',
    name: 'IBB Specialist Hospital',
    aliases: ['ibb hospital', 'specialist hospital', 'ibb specialist'],
    area: 'Minna City Centre',
    lat: 9.6118,
    lng: 6.5518,
    category: 'hospital',
  },
  {
    id: 'mna-009',
    name: 'General Hospital Minna',
    aliases: ['general hospital', 'gen hospital'],
    area: 'Minna City Centre',
    lat: 9.6165,
    lng: 6.5589,
    category: 'hospital',
  },
  {
    id: 'mna-010',
    name: 'Niger State Secretariat',
    aliases: ['secretariat', 'state secretariat', 'niger state sec'],
    area: 'Minna City Centre',
    lat: 9.5981,
    lng: 6.5544,
    category: 'government',
  },
  {
    id: 'mna-011',
    name: "Emir's Palace Minna",
    aliases: ['emirs palace', 'emir palace', 'palace'],
    area: 'Minna City Centre',
    lat: 9.6178,
    lng: 6.5551,
    category: 'landmark',
  },
  {
    id: 'mna-012',
    name: 'Minna Airport',
    aliases: ['airport', 'minna international airport', 'bala mohammed airport'],
    area: 'Maikunkele',
    lat: 9.6522,
    lng: 6.4628,
    category: 'transport',
  },
  {
    id: 'mna-013',
    name: 'Maikunkele',
    aliases: ['mai kunkele', 'maikunkele town'],
    area: 'Maikunkele',
    lat: 9.6871,
    lng: 6.4932,
    category: 'residential',
  },
  {
    id: 'mna-014',
    name: 'Chanchaga',
    aliases: ['chanchaga town', 'chachaga'],
    area: 'Chanchaga',
    lat: 9.5787,
    lng: 6.5619,
    category: 'residential',
  },
  {
    id: 'mna-015',
    name: 'Dutsen Kura Gwari',
    aliases: ['dutsen kura', 'dutsenkura', 'dusten kura'],
    area: 'Dutsen Kura',
    lat: 9.5924,
    lng: 6.5387,
    category: 'residential',
  },
  {
    id: 'mna-016',
    name: 'Sauka Kahuta',
    aliases: ['sauka', 'sauka kauta'],
    area: 'Sauka Kahuta',
    lat: 9.6058,
    lng: 6.5638,
    category: 'residential',
  },
  {
    id: 'mna-017',
    name: 'Limawa',
    aliases: ['limawa road', 'limawa area'],
    area: 'Limawa',
    lat: 9.6203,
    lng: 6.5474,
    category: 'residential',
  },
  {
    id: 'mna-018',
    name: 'GRA Minna',
    aliases: ['gra', 'government reserved area'],
    area: 'GRA',
    lat: 9.6072,
    lng: 6.5602,
    category: 'residential',
  },
  {
    id: 'mna-019',
    name: 'Barkin Sale',
    aliases: ['barkin saleh', 'barikin sale', 'bakin sale'],
    area: 'Barkin Sale',
    lat: 9.6301,
    lng: 6.5289,
    category: 'residential',
  },
  {
    id: 'mna-020',
    name: 'Shiroro Hotel',
    aliases: ['shiroro', 'hotel shiroro'],
    area: 'Minna City Centre',
    lat: 9.6089,
    lng: 6.5577,
    category: 'landmark',
  },
  {
    id: 'mna-021',
    name: 'Justice Legbo Kutigi International Conference Centre',
    aliases: ['kutigi', 'conference centre', 'legbo kutigi', 'iccc'],
    area: 'Minna City Centre',
    lat: 9.6014,
    lng: 6.5531,
    category: 'landmark',
  },
  {
    id: 'mna-022',
    name: 'Paiko Road Junction',
    aliases: ['paiko road', 'paiko', 'paikoro road'],
    area: 'Paiko Road',
    lat: 9.5896,
    lng: 6.5448,
    category: 'landmark',
  },
  {
    id: 'mna-023',
    name: 'Western Bypass',
    aliases: ['bypass', 'western by pass', 'by-pass'],
    area: 'Western Bypass',
    lat: 9.6244,
    lng: 6.5182,
    category: 'landmark',
  },
  {
    id: 'mna-024',
    name: 'Minna Motor Park',
    aliases: ['motor park', 'park', 'garage'],
    area: 'Kpakungu',
    lat: 9.5831,
    lng: 6.5364,
    category: 'transport',
  },
];

/** Namespaced so a seeded row can never collide with a real Google place id. */
export const seededPlaceId = (id: string): string => `aiko:${id}`;

/** What the client shows and what `Address.address` is unique on. */
export const landmarkAddress = (landmark: MinnaLandmark): string =>
  `${landmark.name}, ${landmark.area}, Minna`;

/**
 * The matchable text for one landmark.
 *
 * Name, every alias and the area, lower-cased and pipe-joined — so a contains
 * match on this column behaves like the app's local alias search did.
 */
export const landmarkSearchText = (landmark: MinnaLandmark): string =>
  [landmark.name, ...landmark.aliases, landmark.area, 'minna']
    .join(' | ')
    .toLowerCase();
