export type CircleRole = 'circle_admin' | 'collaborator' | 'viewer';

export interface Circle {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  isPersonal: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CircleMember {
  id: string;
  circleId: string;
  userId: string;
  role: CircleRole;
  createdAt: string;
  user: {
    id: string;
    email: string;
    displayName: string | null;
    profileImageUrl: string | null;
  };
}

export interface CircleInvite {
  id: string;
  circleId: string;
  email: string;
  role: CircleRole;
  notes: string | null;
  addedById: string | null;
  addedAt: string;
  claimedById: string | null;
  claimedAt: string | null;
}
