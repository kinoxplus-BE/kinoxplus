/**
 * Provider seam for the playback plane. Cloudflare Stream today; if content
 * licensing mandates DRM, swap the binding to a Mux implementation — nothing
 * outside this module should notice (AGENTS.md §8).
 */
export const VIDEO_PROVIDER = Symbol('VIDEO_PROVIDER');

export interface DirectUpload {
  videoId: string;
  uploadUrl: string;
}

export interface VideoProvider {
  /** Create a direct-creator upload slot for an admin ingest. */
  createDirectUpload(titleId: string): Promise<DirectUpload>;

  /** Signed, time-limited HLS playback URL for an entitled user. */
  getSignedPlaybackUrl(videoId: string): Promise<string>;
}
