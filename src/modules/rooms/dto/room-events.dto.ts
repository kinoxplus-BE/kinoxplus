import {
  IsBoolean,
  IsNumber,
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
