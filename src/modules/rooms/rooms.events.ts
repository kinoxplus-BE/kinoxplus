export const ROOM_MEMBER_FORCE_LEFT_EVENT = 'rooms.member.force-left';

export type RoomMemberForceLeftReason = 'create-room' | 'join-room';

export interface RoomMemberForceLeftEvent {
  roomId: string;
  userId: string;
  reason: RoomMemberForceLeftReason;
}
