import { fold, stripNoise, suggestionKey } from './normalize-location-name';

describe('fold — alias identity', () => {
  it('strips diacritics and lowercases', () => {
    expect(fold('San José')).toBe('san jose');
    expect(fold('San José')).toBe(fold('SAN JOSE'));
  });

  it('is case-insensitive', () => {
    expect(fold('SAN JOSE')).toBe(fold('san jose'));
    expect(fold('New York City')).toBe(fold('NEW YORK CITY'));
  });

  it('drops punctuation and collapses whitespace', () => {
    expect(fold('St. Louis')).toBe('st louis');
    expect(fold("Coeur d'Alene")).toBe('coeur dalene');
    expect(fold('  New   York  ')).toBe('new york');
  });

  it('handles the curly apostrophe and backtick variants identically', () => {
    expect(fold("Martha's Vineyard")).toBe(fold('Martha’s Vineyard'));
  });

  it('NEVER collapses two genuinely different names', () => {
    // The whole reason fold() is conservative: alias identity must not
    // silently merge distinct places.
    expect(fold('San Jose')).not.toBe(fold('San Juan'));
    expect(fold('Heredia')).not.toBe(fold('Cartago'));
    expect(fold('Springfield')).not.toBe(fold('Springville'));
  });

  it('does NOT strip administrative noise (that is suggestionKey only)', () => {
    expect(fold('Heredia Province')).toBe('heredia province');
    expect(fold('Provincia de Heredia')).toBe('provincia de heredia');
  });
});

describe('suggestionKey — level-aware clustering', () => {
  it('reduces all three Heredia spellings to one region key', () => {
    const a = suggestionKey('region', 'Heredia');
    const b = suggestionKey('region', 'Heredia Province');
    const c = suggestionKey('region', 'Provincia de Heredia');

    expect(a).toBe('heredia');
    expect(b).toBe('heredia');
    expect(c).toBe('heredia');
  });

  it('a country-level key does NOT strip " province"', () => {
    // Administrative noise is only noise at the level it belongs to.
    expect(suggestionKey('country', 'Heredia Province')).toBe('heredia province');
    expect(suggestionKey('country', 'Heredia Province')).not.toBe(
      suggestionKey('region', 'Heredia Province'),
    );
  });

  it('strips the other region leading forms', () => {
    expect(suggestionKey('region', 'Province of Ontario')).toBe('ontario');
    expect(suggestionKey('region', 'Estado de Jalisco')).toBe('jalisco');
    expect(suggestionKey('region', 'State of Texas')).toBe('texas');
    expect(suggestionKey('region', 'Departamento de Antioquia')).toBe('antioquia');
    expect(suggestionKey('region', 'Region of Waterloo')).toBe('waterloo');
  });

  it('strips the other region trailing forms', () => {
    expect(suggestionKey('region', 'Kanagawa Prefecture')).toBe('kanagawa');
    expect(suggestionKey('region', 'Moscow Oblast')).toBe('moscow');
    expect(suggestionKey('region', 'Washington State')).toBe('washington');
  });

  it('strips locality noise', () => {
    expect(suggestionKey('locality', 'City of London')).toBe('london');
    expect(suggestionKey('locality', 'Ciudad de Panama')).toBe('panama');
    expect(suggestionKey('locality', 'Municipio de Escazu')).toBe('escazu');
    expect(suggestionKey('locality', 'Town of Cary')).toBe('cary');
    expect(suggestionKey('locality', 'Quezon City')).toBe('quezon');
    expect(suggestionKey('locality', 'Salinas Municipality')).toBe('salinas');
  });

  it('does NOT apply region noise at locality level, or vice versa', () => {
    expect(suggestionKey('locality', 'Heredia Province')).toBe('heredia province');
    expect(suggestionKey('region', 'Quezon City')).toBe('quezon city');
  });

  it('strips country noise only', () => {
    expect(suggestionKey('country', 'The Netherlands')).toBe('netherlands');
    expect(suggestionKey('country', 'Bahamas (the)')).toBe('bahamas');
  });

  it('longest-first: "provincia de" wins over "provincia"', () => {
    // A naive shortest-first pass would leave "de heredia".
    expect(suggestionKey('region', 'Provincia de Heredia')).toBe('heredia');
  });

  it('folds accents before stripping noise', () => {
    expect(suggestionKey('locality', 'Ciudad de San José')).toBe('san jose');
  });

  it('is still distinct for genuinely different places', () => {
    expect(suggestionKey('region', 'Heredia Province')).not.toBe(
      suggestionKey('region', 'Cartago Province'),
    );
  });
});

describe('stripNoise', () => {
  it('operates on an already-folded string and is a no-op for unknown noise', () => {
    expect(stripNoise('region', 'heredia')).toBe('heredia');
  });

  it('applies at most one leading and one trailing match', () => {
    // "provincia de X province" loses both, but nothing further is whittled.
    expect(stripNoise('region', 'provincia de heredia province')).toBe('heredia');
  });
});
