import { ApiProperty } from '@nestjs/swagger';

export class DirectUploadDto {
  @ApiProperty({
    example: 'cf_stream_video_uid',
    description: 'Provider video id stored as Title.streamVideoId.',
  })
  videoId!: string;

  @ApiProperty({
    example: 'https://upload.videodelivery.net/...',
    description: 'Direct upload URL for the admin client.',
  })
  uploadUrl!: string;
}

export class PlaybackUrlDto {
  @ApiProperty({
    example: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    description:
      'Playable URL. POC titles return public HLS/sample URLs; production titles return signed Cloudflare Stream URLs.',
  })
  url!: string;

  @ApiProperty({
    enum: ['poc-hls', 'cloudflare-stream'],
    example: 'poc-hls',
  })
  provider!: 'poc-hls' | 'cloudflare-stream';
}
