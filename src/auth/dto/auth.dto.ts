import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

/**
 * The only credential the app ever sends.
 *
 * One token type covers both ways in, because Firebase mints the same kind of
 * ID token for a Google sign-in and for a verified phone number — the claims
 * differ, not the format. That is what keeps this to a single endpoint.
 */
export class FirebaseSignInDto {
  @ApiProperty({
    example:
      'eyJhbGciOiJSUzI1NiIsImtpZCI6IjE2ZDRmY2E3NzcwYjBiZjRjZTQ0MGY5NmU5NzNmZDdiMDdmYzNhZTgiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwczovL3NlY3VyZXRva2VuLmdvb2dsZS5jb20vYWlrby03ODc0YiIsImF1ZCI6ImFpa28tNzg3NGIiLCJhdXRoX3RpbWUiOjE3ODUzMTU5NTMsInVzZXJfaWQiOiJZakZ4TjJKa1EyaHlSVzFqUjNvNSIsInN1YiI6IllqRnhOMkprUTJoeVJXMWpSM281IiwiaWF0IjoxNzg1MzE1OTUzLCJleHAiOjE3ODUzMTk1NTN9.SIGNATURE',
    description:
      'The ID token from `getIdToken()` on the Firebase client, after either a Google sign-in or a verified phone OTP.',
  })
  @IsString()
  @MinLength(20)
  idToken: string;
}

/** Staff sign-in. App users have no password and can never satisfy this. */
export class LoginDto {
  @ApiProperty({ example: 'admin@aiko.ng' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'ChangeMe123!' })
  @IsString()
  password: string;
}
