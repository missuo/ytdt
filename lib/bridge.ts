import type { CaptionTrack, VideoInfo } from './types';

/** Tag on window.postMessage payloads exchanged between the MAIN and ISOLATED worlds. */
export const BRIDGE_TAG = '__ytdt_bridge__';

export interface BridgeMethods {
  getVideoInfo: { params: { videoId: string }; result: VideoInfo };
  fetchTrack: { params: { videoId: string; track: CaptionTrack }; result: string };
}

export type BridgeMethod = keyof BridgeMethods;

export interface BridgeRequest<M extends BridgeMethod = BridgeMethod> {
  [BRIDGE_TAG]: 'req';
  id: string;
  method: M;
  params: BridgeMethods[M]['params'];
}

export interface BridgeResponse {
  [BRIDGE_TAG]: 'res';
  id: string;
  result?: unknown;
  error?: string;
}
