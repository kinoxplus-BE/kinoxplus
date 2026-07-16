import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';

export class CheckUsernameDto {
  @ApiProperty({ example: 'priyan', description: 'Handle to check' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase().trim() : value,
  )
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9._]{2,19}$/, {
    message:
      'Username must be 3-20 characters: lowercase letters, digits, "." or "_", starting with a letter or digit',
  })
  username!: string;
}
