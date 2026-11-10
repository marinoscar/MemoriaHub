import type { SVGProps } from 'react';

import { MEMORIAHUB_BRAND } from './identity.js';

/**
 * Props of {@link BrandMark}.
 *
 * @stability experimental
 */
export interface BrandMarkProps extends Omit<SVGProps<SVGSVGElement>, 'children' | 'viewBox'> {
  /** The side of the mark in pixels. Default 32. */
  size?: number;
  /** An accessible name; without one the mark is decorative (`aria-hidden`). */
  title?: string;
}

/**
 * The MemoriaHub mark: a rounded plate in the brand colour holding a photo frame
 * with a sun and a hill. Pure SVG, so it paints in any host with no asset pipeline.
 *
 * @param props - size, an optional accessible name and SVG attributes.
 * @returns the SVG element.
 *
 * @stability experimental
 */
export function BrandMark({ size = 32, title, ...rest }: BrandMarkProps) {
  const labelled = title !== undefined;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role={labelled ? 'img' : undefined}
      aria-hidden={labelled ? undefined : true}
      aria-label={title}
      {...rest}
    >
      <rect width="64" height="64" rx="14" fill={MEMORIAHUB_BRAND.themeColor} />
      <rect x="14" y="16" width="36" height="32" rx="5" fill="none" stroke="#ffffff" strokeWidth="3" />
      <circle cx="26" cy="27" r="4" fill="#ffffff" />
      <path d="M16 46l10-10 7 7 6-6 9 9z" fill="#ffffff" />
    </svg>
  );
}
