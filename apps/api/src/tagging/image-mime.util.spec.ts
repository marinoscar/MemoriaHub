import { detectImageMime } from './image-mime.util';

describe('detectImageMime', () => {
  it('detects JPEG from FF D8 FF magic bytes', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(detectImageMime(buf)).toBe('image/jpeg');
  });

  it('detects PNG from 89 50 4E 47 magic bytes', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectImageMime(buf)).toBe('image/png');
  });

  it('detects GIF from 47 49 46 38 magic bytes', () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    expect(detectImageMime(buf)).toBe('image/gif');
  });

  it('detects WebP from RIFF....WEBP magic bytes', () => {
    const buf = Buffer.alloc(12);
    buf.write('RIFF', 0, 'ascii');
    buf.write('WEBP', 8, 'ascii');
    expect(detectImageMime(buf)).toBe('image/webp');
  });

  it('returns null for HEIC (ftyp box, not in detection list)', () => {
    // HEIC starts with a ftyp box — first 4 bytes are box size, then 'ftyp'
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    expect(detectImageMime(buf)).toBeNull();
  });

  it('returns null for short/garbage buffer', () => {
    expect(detectImageMime(Buffer.from([0x00, 0x01]))).toBeNull();
    expect(detectImageMime(Buffer.alloc(0))).toBeNull();
  });

  it('returns null for random bytes that match no known format', () => {
    const buf = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
    expect(detectImageMime(buf)).toBeNull();
  });
});
