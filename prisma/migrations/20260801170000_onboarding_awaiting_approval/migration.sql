-- AlterEnum
-- Appended rather than inserted before DONE: Postgres orders enum values by
-- their declared position, and rewriting the type to slot this one in would
-- mean dropping and recreating every column that uses it. Step ordering lives
-- in ONBOARDING_SEQUENCE, not in the enum.
ALTER TYPE "OnboardingStep" ADD VALUE 'AWAITING_APPROVAL';
