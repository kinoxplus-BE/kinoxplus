import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
} from 'class-validator';

const lowerTrim = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value)
    ? (value as unknown[]).map((v) =>
        typeof v === 'string' ? v.toLowerCase().trim() : v,
      )
    : value;

export class CreateInvitationsDto {
  @ApiPropertyOptional({
    example: ['friend@example.com', 'roommate@example.com'],
    description:
      'Email addresses to invite. Emails matching existing accounts get push + in-app; unattached emails get an email with the universal link.',
    isArray: true,
    type: String,
  })
  @IsOptional()
  @Transform(lowerTrim)
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsEmail({}, { each: true })
  emails?: string[];

  @ApiPropertyOptional({
    example: ['cmd9x0abc0000v0f4user1', 'cmd9x0abc0000v0f4user2'],
    description:
      'User IDs to invite (from an in-app people-picker). Push + in-app.',
    isArray: true,
    type: String,
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  userIds?: string[];
}
