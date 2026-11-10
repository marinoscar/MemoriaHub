// The per-circle role names (RETRO-K2): the `CircleRole` database enum is gone, the `/api/circles/*`
// routes still speak these names and older specs seed roles with them.
export const CircleRole = {
  circle_admin: 'circle_admin',
  collaborator: 'collaborator',
  viewer: 'viewer',
} as const;
export type CircleRole = (typeof CircleRole)[keyof typeof CircleRole];
