import { randomBytes } from 'crypto';
import { extname } from 'path';

/** Strips anything that could escape the target folder or break a URL. */
export function sanitiseSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9/_-]/g, '-').replace(/^\/+|\/+$/g, '');
}

/**
 * `vehicles/<driverId>/1712345678901-a1b2c3d4.jpg`
 * Random suffix keeps concurrent uploads of the same filename from colliding.
 */
export function buildObjectKey(originalName: string, folder?: string): string {
  const ext = extname(originalName || '').toLowerCase().slice(0, 10);
  const name = `${Date.now()}-${randomBytes(4).toString('hex')}${ext}`;
  const prefix = folder ? sanitiseSegment(folder) : '';
  return prefix ? `${prefix}/${name}` : name;
}
