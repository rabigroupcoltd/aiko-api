import { Prisma } from '@prisma/client';

/** Never send the password hash over the wire. */
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
  accountType: true,
  onboardingStep: true,
  onboardingCompletedAt: true,
  livenessPassedAt: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

/** What a counterparty on a ride is allowed to see. */
export const CONTACT_USER_SELECT = {
  id: true,
  name: true,
  phone: true,
} satisfies Prisma.UserSelect;
