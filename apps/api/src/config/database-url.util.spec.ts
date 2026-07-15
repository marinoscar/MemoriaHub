import {
  buildBaseDatabaseUrl,
  appendPoolParams,
  buildDatabaseUrl,
  resolvePoolConfig,
} from './database-url.util';

describe('buildBaseDatabaseUrl', () => {
  it('builds postgresql://user:pass@host:port/db from POSTGRES_* vars', () => {
    const env = {
      POSTGRES_HOST: 'db.example.com',
      POSTGRES_PORT: '5433',
      POSTGRES_USER: 'appuser',
      POSTGRES_PASSWORD: 'secret',
      POSTGRES_DB: 'mydb',
    };
    expect(buildBaseDatabaseUrl(env)).toBe(
      'postgresql://appuser:secret@db.example.com:5433/mydb',
    );
  });

  it('applies ?sslmode=require only when POSTGRES_SSL==="true"', () => {
    const withSsl = buildBaseDatabaseUrl({
      POSTGRES_HOST: 'db.example.com',
      POSTGRES_SSL: 'true',
    });
    expect(withSsl).toContain('?sslmode=require');

    const withSslFalse = buildBaseDatabaseUrl({
      POSTGRES_HOST: 'db.example.com',
      POSTGRES_SSL: 'false',
    });
    expect(withSslFalse).not.toContain('sslmode=require');

    const withSslUnset = buildBaseDatabaseUrl({
      POSTGRES_HOST: 'db.example.com',
    });
    expect(withSslUnset).not.toContain('sslmode=require');
  });

  it('URL-encodes the password when it contains @, :, and a space', () => {
    const password = 'p@ss w:rd';
    const url = buildBaseDatabaseUrl({
      POSTGRES_HOST: 'db.example.com',
      POSTGRES_PASSWORD: password,
    });
    expect(url).toContain(encodeURIComponent(password));

    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.password)).toBe(password);
  });

  it('returns env.DATABASE_URL verbatim when set, ignoring POSTGRES_* entirely', () => {
    const env = {
      DATABASE_URL: 'postgresql://verbatim:url@host/db',
      POSTGRES_HOST: 'ignored-host',
      POSTGRES_PORT: '9999',
      POSTGRES_USER: 'ignored-user',
      POSTGRES_PASSWORD: 'ignored-password',
      POSTGRES_DB: 'ignored-db',
    };
    expect(buildBaseDatabaseUrl(env)).toBe('postgresql://verbatim:url@host/db');
  });

  it('uses documented defaults when POSTGRES_* and DATABASE_URL are all unset', () => {
    expect(buildBaseDatabaseUrl({})).toBe(
      'postgresql://postgres:postgres@localhost:5432/appdb',
    );
  });
});

describe('appendPoolParams', () => {
  it('appends connection_limit and pool_timeout with a leading ? when the url has no query string yet', () => {
    const result = appendPoolParams('postgresql://x/y', {
      DB_CONNECTION_LIMIT: '25',
      DB_POOL_TIMEOUT: '30',
    });
    expect(result).toBe('postgresql://x/y?connection_limit=25&pool_timeout=30');
  });

  it('uses & when the url already has a query string', () => {
    const result = appendPoolParams('postgresql://x/y?sslmode=require', {
      DB_CONNECTION_LIMIT: '25',
      DB_POOL_TIMEOUT: '30',
    });
    expect(result).toBe(
      'postgresql://x/y?sslmode=require&connection_limit=25&pool_timeout=30',
    );
  });

  it('is idempotent: a url that already contains connection_limit= is returned completely unchanged', () => {
    const url = 'postgresql://x/y?connection_limit=5';
    const result = appendPoolParams(url, {
      DB_CONNECTION_LIMIT: '999',
      DB_POOL_TIMEOUT: '999',
    });
    expect(result).toBe(url);
  });

  it('applies defaults connection_limit=10 and pool_timeout=20 when unset', () => {
    const result = appendPoolParams('postgresql://x/y', {});
    expect(result).toBe('postgresql://x/y?connection_limit=10&pool_timeout=20');
  });

  it('honors explicit valid values', () => {
    const result = appendPoolParams('postgresql://x/y', {
      DB_CONNECTION_LIMIT: '25',
      DB_POOL_TIMEOUT: '30',
    });
    expect(result).toBe('postgresql://x/y?connection_limit=25&pool_timeout=30');
  });

  it('skips a param whose explicit value is invalid/non-positive/empty while still applying the other param default', () => {
    for (const invalid of ['abc', '0', '']) {
      const result = appendPoolParams('postgresql://x/y', {
        DB_CONNECTION_LIMIT: invalid,
      });
      expect(result).toContain('pool_timeout=20');
      expect(result).not.toContain('connection_limit=');
    }
  });
});

describe('buildDatabaseUrl', () => {
  it('composes base url + pool params with ssl and explicit pool overrides', () => {
    const env = {
      POSTGRES_HOST: 'db.example.com',
      POSTGRES_PORT: '5433',
      POSTGRES_USER: 'appuser',
      POSTGRES_PASSWORD: 'secret',
      POSTGRES_DB: 'mydb',
      POSTGRES_SSL: 'true',
      DB_CONNECTION_LIMIT: '25',
      DB_POOL_TIMEOUT: '30',
    };
    expect(buildDatabaseUrl(env)).toBe(
      'postgresql://appuser:secret@db.example.com:5433/mydb?sslmode=require&connection_limit=25&pool_timeout=30',
    );
  });

  it('produces the no-SSL/default-pool-params case with a leading ?', () => {
    const env = {
      POSTGRES_HOST: 'db.example.com',
      POSTGRES_PORT: '5432',
      POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: 'postgres',
      POSTGRES_DB: 'db',
    };
    expect(buildDatabaseUrl(env)).toBe(
      'postgresql://postgres:postgres@db.example.com:5432/db?connection_limit=10&pool_timeout=20',
    );
  });
});

describe('resolvePoolConfig', () => {
  it('returns defaults when env is empty', () => {
    expect(resolvePoolConfig({})).toEqual({
      max: 10,
      connectionTimeoutMillis: 20000,
    });
  });

  it('returns custom valid values, converting pool timeout seconds to ms', () => {
    expect(
      resolvePoolConfig({ DB_CONNECTION_LIMIT: '25', DB_POOL_TIMEOUT: '30' }),
    ).toEqual({
      max: 25,
      connectionTimeoutMillis: 30000,
    });
  });

  it('falls back to defaults when values are invalid/non-positive', () => {
    expect(
      resolvePoolConfig({ DB_CONNECTION_LIMIT: 'abc', DB_POOL_TIMEOUT: '-1' }),
    ).toEqual({
      max: 10,
      connectionTimeoutMillis: 20000,
    });
  });
});
