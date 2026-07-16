import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { GENRES, type GenreName } from '../../../common/constants/genres';

export class UpdateProfileDto {
  @ApiPropertyOptional({
    example: 'Ada Lovelace',
    minLength: 2,
    maxLength: 50,
    description: 'Full name',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  displayName?: string;

  @ApiPropertyOptional({
    example: 'priyan',
    description: 'Handle shown in rooms. Case-insensitive unique.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase().trim() : value,
  )
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9._]{2,19}$/, {
    message:
      'Username must be 3-20 characters: lowercase letters, digits, "." or "_", starting with a letter or digit',
  })
  username?: string;

  @ApiPropertyOptional({ example: 'https://res.cloudinary.com/...' })
  @IsOptional()
  @IsUrl()
  avatarUrl?: string;

  @ApiPropertyOptional({ example: '#3652D9' })
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

  @ApiPropertyOptional({
    example: ['Comedy', 'Family', 'Fantasy'],
    enum: GENRES,
    isArray: true,
    minItems: 3,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(3)
  @ArrayUnique()
  @IsIn(GENRES, { each: true })
  preferredGenres?: GenreName[];
}
