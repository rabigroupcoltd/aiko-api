import { randomBytes } from 'crypto';
import { extname } from 'path';

export function sanitiseSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9/_-]/g, '-').replace(/^\/+|\/+$/g, '');
}

export function buildObjectKey(originalName: string, folder?: string): string {
  const ext = extname(originalName || '').toLowerCase().slice(0, 10);
  const name = `${Date.now()}-${randomBytes(4).toString('hex')}${ext}`;
  const prefix = folder ? sanitiseSegment(folder) : '';
  return prefix ? `${prefix}/${name}` : name;
}
