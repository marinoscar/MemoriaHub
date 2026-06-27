/**
 * GeoNames uses USPS 2-letter abbreviations as admin1Code values for US records.
 * The local-reverse-geocoder library does not reliably expand these into full state
 * names via admin1Name (e.g. California returns null while Texas is populated).
 * This lookup table provides a deterministic fallback so geoAdmin1 is always set
 * for US locations.
 *
 * Includes all 50 states, DC, and the five US territories that GeoNames represents
 * as US admin1 entries (PR, VI, GU, AS, MP) — 56 entries total.
 */
export const US_STATE_CODES: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  // Federal district
  DC: 'District of Columbia',
  // US territories represented as US admin1 in GeoNames
  PR: 'Puerto Rico',
  VI: 'U.S. Virgin Islands',
  GU: 'Guam',
  AS: 'American Samoa',
  MP: 'Northern Mariana Islands',
};

/**
 * Resolve a GeoNames US admin1Code (USPS 2-letter abbreviation) to its full
 * state or territory name.  Returns undefined when the code is absent or
 * unrecognised, so callers can continue down their own fallback chain.
 */
export function resolveUsState(code?: string): string | undefined {
  if (!code) return undefined;
  return US_STATE_CODES[code.toUpperCase().trim()];
}
