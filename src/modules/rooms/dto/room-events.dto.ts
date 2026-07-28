import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Payloads for the /rooms Socket.io namespace (AGENTS.md §6). */

export class RoomRefDto {
  @IsString()
  roomId!: string;
}

export class JoinRoomDto extends RoomRefDto {
  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(16)
  code?: string;

  /** If true, auto-leave any other active room this user is in. Without
   * it, joining while already in another room returns ALREADY_IN_ROOM. */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class ControlDto extends RoomRefDto {
  @IsNumber()
  @Min(0)
  positionSec!: number;
}

export class HeartbeatDto extends ControlDto {
  /** Host clock (ms epoch) when the tick was emitted. */
  @IsNumber()
  ts!: number;
}

export class ChatSendDto extends RoomRefDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  body!: string;
}

export class MuteDto extends RoomRefDto {
  @IsString()
  targetUserId!: string;

  @IsBoolean()
  muted!: boolean;
}

export class KickMemberDto extends RoomRefDto {
  @IsString()
  targetUserId!: string;
}

export class TransferHostDto extends RoomRefDto {
  @IsString()
  targetUserId!: string;
}

export class ChangeTitleDto extends RoomRefDto {
  @IsString()
  titleId!: string;
}
