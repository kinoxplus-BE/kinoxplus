import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { DeviceInfoDto, DeviceInfoField } from './device-info.dto';

export class GoogleSignInDto {
  @ApiProperty({
    description:
      "The Google ID token (JWT) the client received from Google's SDK after the user picked their account. On React Native, this is the `idToken` field of the `GoogleSignin.signIn()` result.",
    example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6…',
  })
  @IsString()
  @MinLength(100)
  idToken!: string;

  @DeviceInfoField()
  device?: DeviceInfoDto;
}
