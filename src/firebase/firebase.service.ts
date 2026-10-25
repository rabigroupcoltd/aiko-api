import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { DecodedIdToken, getAuth } from 'firebase-admin/auth';
import { Messaging, getMessaging } from 'firebase-admin/messaging';

export interface FirebaseIdentity {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  displayName: string | null;
  photoUrl: string | null;
  signInProvider: string | null;
}

export type VerifyResult =
  | { ok: true; identity: FirebaseIdentity }
  | { ok: false; reason: 'not-configured' | 'expired' | 'revoked' | 'invalid'; message: string };

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

  get messaging(): Messaging | null {
    return this.app ? getMessaging(this.app) : null;
  }

  private createApp(): App | null {
    const existing = getApps();
    if (existing.length > 0) return existing[0];

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    try {
      if (projectId && clientEmail && privateKey) {
        return initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
      }

      if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        return initializeApp();
      }
    } catch (error: any) {
      this.logger.error(`Firebase init failed: ${error?.message}`);
    }

    return null;
  }

  async deleteUser(uid: string): Promise<void> {
    if (!this.app) return;
    try {
      await getAuth(this.app).deleteUser(uid);
    } catch (error: any) {
      if (error?.code !== 'auth/user-not-found') {
        this.logger.warn(`Could not delete Firebase user: ${error?.code || error?.message}`);
      }
    }
  }

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
