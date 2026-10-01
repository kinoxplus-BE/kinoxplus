import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class SendFriendRequestDto {
  @ApiProperty({
    example: 'adaeze_o',
    description: 'Username of the user to send a friend request to.',
  })
  @IsString()
  @Length(3, 24)
  username!: string;
}
