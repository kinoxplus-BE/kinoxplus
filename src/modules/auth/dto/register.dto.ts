import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { GENRES, type GenreName } from '../../../common/constants/genres';

const lowercaseTrim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toLowerCase().trim() : value;

/**
 * One-shot payload for the 3-step signup wizard: the app collects
 * step 1 (personal details) + step 2 (categories) + step 3 (profile)
 * client-side and submits everything on "Create Account".
 */
export class RegisterDto {
  // ── Step 1 · Personal details ──

  @ApiProperty({ example: 'Ada Lovelace', minLength: 2, maxLength: 50 })
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  fullName!: string;

  @ApiProperty({ example: 'ada@example.com' })
  @Transform(lowercaseTrim)
  @IsEmail()
  email!: string;

  @ApiProperty({
    example: 'correct horse battery',
    minLength: 8,
    maxLength: 72,
    description: 'At least 8 characters. No composition rules (NIST 800-63B).',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @ApiProperty({
    example: '2000-05-14',
    description: 'ISO date (YYYY-MM-DD). Must be at least 13 years old.',
  })
  @IsDateString()
  dateOfBirth!: string;

  // ── Step 2 · Movie categories ──

  @ApiProperty({
    example: ['Comedy', 'Family', 'Fantasy', 'Mystery'],
    enum: GENRES,
    isArray: true,
    minItems: 3,
    description: 'At least 3 genres to personalize the home feed.',
  })
  @IsArray()
  @ArrayMinSize(3)
  @ArrayUnique()
  @IsIn(GENRES, { each: true })
  preferredGenres!: GenreName[];

  // ── Email verification proof (between steps 2 and 3) ──

  @ApiProperty({
    example: '3f1c8a2d5e9b0f47c6a1d8e3b5f2a9c04d7e1b8f5a2c9e6b3d0f7a4c1e8b5d2a',
    description:
      'Single-use token from POST /auth/otp/verify with purpose "signup" — proves this email was verified during the wizard. Valid 30 minutes.',
  })
  @IsString()
  @Length(64, 64)
  signupToken!: string;

  // ── Step 3 · Profile ──

  @ApiProperty({
    example: 'priyan',
    minLength: 3,
    maxLength: 20,
    description:
      'Handle friends see in rooms. Lowercase letters, digits, "." and "_"; must start with a letter or digit. Case-insensitive unique.',
  })
  @Transform(lowercaseTrim)
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9._]{2,19}$/, {
    message:
      'Username must be 3-20 characters: lowercase letters, digits, "." or "_", starting with a letter or digit',
  })
  username!: string;

  @ApiPropertyOptional({
    example: '#3652D9',
    description: 'Avatar swatch color (hex) until an avatar image is uploaded.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, {
    message: 'avatarColor must be a hex color like #3652D9',
  })
  avatarColor?: string;

  @ApiPropertyOptional({
    example: 'Movie nights are my religion.',
    maxLength: 160,
  })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  bio?: string;

  // ── Extras (not in the wizard, kept for future use) ──

  @ApiPropertyOptional({
    example: '+2348012345678',
    description: 'E.164 phone number',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\+[1-9]\d{6,14}$/, { message: 'Phone must be in E.164 format' })
  phone?: string;
}
