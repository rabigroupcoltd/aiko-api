import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { DecodedIdToken, getAuth } from 'firebase-admin/auth';
import { Messaging, getMessaging } from 'firebase-admin/messaging';

/** The identity we care about, flattened out of the Firebase token claims. */
export interface FirebaseIdentity {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  displayName: string | null;
  photoUrl: string | null;
  /** `google.com`, `phone`, `password`, … — whichever provider minted the token. */
  signInProvider: string | null;
}

export type VerifyResult =
  | { ok: true; identity: FirebaseIdentity }
  | { ok: false; reason: 'not-configured' | 'expired' | 'revoked' | 'invalid'; message: string };

/**
 * Wraps the Firebase Admin SDK.
 *
 * Credentials come from the environment rather than a checked-in key file, so
 * the service account JSON never has to live inside the repo. Either supply the
 * three FIREBASE_* variables, or point GOOGLE_APPLICATION_CREDENTIALS at the
 * file and leave them unset.
 *
 * When nothing is configured the service stays disabled instead of throwing at
 * boot — the rest of the API must still start for local work that does not
 * touch sign-in.
 *
 * The same credentials back both features that need Firebase: verifying sign-in
 * tokens, and sending push through FCM.
 */
@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private app: App | null = null;

  onModuleInit() {
    this.app = this.createApp();

    if (!this.app) {
      this.logger.warn(
        'Firebase is not configured — POST /api/auth/firebase will reject every ' +
          'request and no push notification will be sent. Set FIREBASE_PROJECT_ID, ' +
          'FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY, or ' +
          'GOOGLE_APPLICATION_CREDENTIALS.',
      );
    }
  }

  get isConfigured(): boolean {
    return this.app !== null;
  }

  /**
   * The FCM client, or null when Firebase is not configured.
   *
   * Returning null rather than throwing keeps push a best-effort concern: a
   * local instance with no service account still serves rides, it just cannot
   * notify anyone.
   */
  get messaging(): Messaging | null {
    return this.app ? getMessaging(this.app) : null;
  }

  private createApp(): App | null {
    // Reusing the default app matters under `--watch`, where the module is
    // re-instantiated but the Firebase singleton survives.
    const existing = getApps();
    if (existing.length > 0) return existing[0];

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    // Escaped newlines are what you get pasting a key into a .env file.
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    try {
      if (projectId && clientEmail && privateKey) {
        return initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
      }

      // applicationDefault() reads GOOGLE_APPLICATION_CREDENTIALS itself.
      if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        return initializeApp();
      }
    } catch (error: any) {
      this.logger.error(`Firebase init failed: ${error?.message}`);
    }

    return null;
  }

  /**
   * Verifies an ID token minted by any Firebase provider.
   *
   * `checkRevoked` is on: a user who was disabled or had their sessions revoked
   * in the Firebase console must stop being able to authenticate here, which a
   * signature-only check would not catch until the token expired on its own.
   */
  async verifyIdToken(idToken: string): Promise<VerifyResult> {
    if (!this.app) {
      return {
        ok: false,
        reason: 'not-configured',
        message: 'Firebase authentication is not configured on this server',
      };
    }

    try {
      const decoded = await getAuth(this.app).verifyIdToken(idToken, true);
      return { ok: true, identity: this.toIdentity(decoded) };
    } catch (error: any) {
      const code: string = error?.code ?? '';

      if (code === 'auth/id-token-expired') {
        return { ok: false, reason: 'expired', message: 'Sign-in token has expired' };
      }
      if (code === 'auth/id-token-revoked' || code === 'auth/user-disabled') {
        return { ok: false, reason: 'revoked', message: 'This account is no longer active' };
      }

      this.logger.warn(`ID token rejected: ${code || error?.message}`);
      return { ok: false, reason: 'invalid', message: 'Invalid sign-in token' };
    }
  }

  private toIdentity(token: DecodedIdToken): FirebaseIdentity {
    // Google puts the good stuff in `firebase.identities`; the top-level claims
    // are only populated for some providers, so fall back across both.
    const identities = (token.firebase?.identities ?? {}) as Record<string, string[]>;
    const emailClaim = token.email ?? identities['email']?.[0] ?? null;
    const phoneClaim = token.phone_number ?? identities['phone']?.[0] ?? null;

    return {
      uid: token.uid,
      email: emailClaim ? emailClaim.trim().toLowerCase() : null,
      emailVerified: Boolean(token.email_verified),
      phone: phoneClaim ?? null,
      displayName: (token.name as string) ?? null,
      photoUrl: (token.picture as string) ?? null,
      signInProvider: token.firebase?.sign_in_provider ?? null,
    };
  }
}
