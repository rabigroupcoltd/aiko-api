import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';

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

export class LoginDto {
  @ApiProperty({ example: 'admin@aiko.ng' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'ChangeMe123!' })
  @IsString()
  password: string;
}
