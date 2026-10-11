import { Prisma } from '@prisma/client';

export const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  firstName: true,
  lastName: true,
  phone: true,
  dob: true,
  photoUrl: true,
  profilePhotoUrl: true,
  roles: true,
  authProvider: true,
  emailVerified: true,
  phoneVerified: true,
  isBlocked: true,
  blockedReason: true,
  accountType: true,
  onboardingStep: true,
  onboardingCompletedAt: true,
  livenessPassedAt: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export const CONTACT_USER_SELECT = {
  id: true,
  name: true,
  phone: true,
} satisfies Prisma.UserSelect;
