import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreateRoomDto {
  @ApiPropertyOptional({
    example: 'cmd9x0abc0000v0f4title1234',
    description:
      'Catalog title id. Optional — omit to start the room in "lobby" mode with no movie picked. The host can pick or change the title later via the title:change socket event.',
  })
  @IsOptional()
  @IsString()
  titleId?: string;

  @ApiPropertyOptional({
    example: true,
    default: true,
    description: 'Private rooms are invite-code based.',
  })
  @IsOptional()
  @IsBoolean()
  isPrivate?: boolean;

  @ApiPropertyOptional({
    example: 20,
    minimum: 2,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(100)
  maxMembers?: number;
}
