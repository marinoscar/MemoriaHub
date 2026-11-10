import { z } from 'zod';

// The per-circle role names the `/api/circles/*` routes still speak (the Android app and older
// clients send and read them). The `CircleRole` database enum is gone with the circle tables
// (RETRO-K2); a role is stored as a platform group role (`admin` / `editor` / `viewer`).
export const CIRCLE_ROLE_VALUES = ['circle_admin', 'collaborator', 'viewer'] as const;
export type CircleRoleName = (typeof CIRCLE_ROLE_VALUES)[number];
export const circleRoleSchema = z.enum(CIRCLE_ROLE_VALUES);

/** Group role -> the circle role name the routes return. */
export const GROUP_ROLE_TO_CIRCLE_ROLE: Readonly<Record<string, CircleRoleName>> = Object.freeze({
  admin: 'circle_admin',
  editor: 'collaborator',
  viewer: 'viewer',
});
