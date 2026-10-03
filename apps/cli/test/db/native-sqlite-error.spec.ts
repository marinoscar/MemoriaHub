/**
 * test/db/native-sqlite-error.spec.ts
 *
 * Issue #541: a better-sqlite3 install without its native `.node` binary (npm
 * 11 skips dependency install scripts unless allow-listed) used to crash
 * openDb with a raw "Could not locate the bindings file" path dump. These
 * tests cover the classifier/message, and openDb's translation of a throwing
 * `new Database()` (better-sqlite3 is loaded via createRequire, so
 * `node:module` is mocked to hand openDb a fake constructor).
 */

import { jest } from '@jest/globals';

let constructorError: unknown = null;

class FakeDatabase {
  constructor() {
    if (constructorError) throw constructorError;
  }
}

const fakeRequire = Object.assign((_id: string) => FakeDatabase, {
  resolve: (_id: string) => '/opt/mh/app/node_modules/better-sqlite3/package.json',
});

jest.unstable_mockModule('node:module', () => ({
  createRequire: () => fakeRequire,
  default: { createRequire: () => fakeRequire },
}));

const {
  NativeSqliteUnavailableError,
  isNativeBindingError,
  nativeSqliteMessage,
  toNativeSqliteError,
  INSTALLER_COMMAND,
} = await import('../../src/db/native-sqlite-error.js');
const { openDb } = await import('../../src/db/database.js');

const ctx = {
  nodeVersion: 'v24.1.0',
  platform: 'linux',
  arch: 'x64',
  packageDir: '/home/u/.memoriahub/app/node_modules/better-sqlite3',
};

function bindingsNotFound(): Error {
  return new Error(
    'Could not locate the bindings file. Tried:\n → /x/build/better_sqlite3.node\n → /x/build/Release/better_sqlite3.node',
  );
}

function dlopenFailed(): Error {
  const err = new Error('/x/build/Release/better_sqlite3.node: cannot open shared object file');
  (err as NodeJS.ErrnoException).code = 'ERR_DLOPEN_FAILED';
  return err;
}

function abiMismatch(): Error {
  return new Error(
    "The module '/x/better_sqlite3.node' was compiled against a different Node.js version using " +
      'NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 137.',
  );
}

describe('isNativeBindingError', () => {
  it.each([
    ['bindings file not found', bindingsNotFound()],
    ['ERR_DLOPEN_FAILED', dlopenFailed()],
    ['NODE_MODULE_VERSION mismatch', abiMismatch()],
    ['invalid ELF header', new Error('/x/better_sqlite3.node: invalid ELF header')],
  ])('recognizes %s', (_label, err) => {
    expect(isNativeBindingError(err)).toBe(true);
  });

  it.each([
    ['an SQLite error', new Error('SQLITE_CANTOPEN: unable to open database file')],
    ['a permission error', Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })],
    ['a non-error value', 'boom'],
    ['null', null],
  ])('ignores %s', (_label, err) => {
    expect(isNativeBindingError(err)).toBe(false);
  });
});

describe('nativeSqliteMessage', () => {
  it('names the Node version and platform, the cause, and both fixes', () => {
    const msg = nativeSqliteMessage(ctx);
    const lines = msg.split('\n');
    expect(lines[0]).toBe(
      "MemoriaHub's SQLite engine (better-sqlite3) is missing its native binary for Node v24.1.0 (linux-x64).",
    );
    expect(msg).toContain('npm 11');
    expect(msg).toContain('Node was upgraded');
    expect(msg).toContain(`cd ${ctx.packageDir} && ../.bin/prebuild-install`);
    expect(msg).toContain(INSTALLER_COMMAND);
    // Short and free of the raw path dump.
    expect(msg).not.toContain('Tried:');
    expect(lines.length).toBeLessThanOrEqual(8);
  });
});

describe('toNativeSqliteError', () => {
  it.each([
    ['bindings file not found', bindingsNotFound],
    ['ERR_DLOPEN_FAILED', dlopenFailed],
    ['NODE_MODULE_VERSION mismatch', abiMismatch],
  ])('wraps %s in NativeSqliteUnavailableError with cause and fix command', (_label, make) => {
    const original = make();
    const result = toNativeSqliteError(original, ctx);
    expect(result).toBeInstanceOf(NativeSqliteUnavailableError);
    const wrapped = result as InstanceType<typeof NativeSqliteUnavailableError>;
    expect(wrapped.name).toBe('NativeSqliteUnavailableError');
    expect(wrapped.cause).toBe(original);
    expect(wrapped.message).toContain(`cd ${ctx.packageDir} && ../.bin/prebuild-install`);
  });

  it('returns an unrelated error unchanged', () => {
    const original = new Error('SQLITE_CORRUPT: database disk image is malformed');
    expect(toNativeSqliteError(original, ctx)).toBe(original);
  });

  it('defaults the context to the running process and the resolved package dir', () => {
    const wrapped = toNativeSqliteError(bindingsNotFound()) as Error;
    expect(wrapped.message).toContain(`Node ${process.version} (${process.platform}-${process.arch})`);
    expect(wrapped.message).toContain('cd /opt/mh/app/node_modules/better-sqlite3 && ../.bin/prebuild-install');
  });
});

describe('openDb native-binding handling', () => {
  afterEach(() => {
    constructorError = null;
  });

  it('throws NativeSqliteUnavailableError (with cause) when the binding is missing', () => {
    const original = bindingsNotFound();
    constructorError = original;
    let caught: unknown;
    try {
      openDb(':memory:');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NativeSqliteUnavailableError);
    expect((caught as Error).cause).toBe(original);
    expect((caught as Error).message).toContain(
      'cd /opt/mh/app/node_modules/better-sqlite3 && ../.bin/prebuild-install',
    );
  });

  it('rethrows other constructor errors unchanged', () => {
    const original = new Error('SQLITE_CANTOPEN: unable to open database file');
    constructorError = original;
    expect(() => openDb(':memory:')).toThrow(original);
  });
});
