import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Accepts either an email (`@` in the string) or an E.164 phone number
 * (starts with `+`). The service picks the right where-clause at lookup time.
 */
export class LoginDto {
  @ApiProperty({
    example: 'ada@example.com',
    description:
      'Email address OR E.164 phone number (e.g. +2348012345678). Emails are lowercased.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Matches(/^(.+@.+\..+|\+[1-9]\d{6,14})$/, {
    message:
      'identifier must be a valid email or E.164 phone number (e.g. +2348012345678)',
  })
  identifier!: string;

  @ApiProperty({
    example: 'correct horse battery',
    minLength: 8,
    maxLength: 72,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}
