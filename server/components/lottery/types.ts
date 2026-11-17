// Props the lottery stage takes, and the per-frame show state its parts read.

export interface StagePerson {
  memberId: number;
  displayName: string;
}

export interface StageEntrant extends StagePerson {
  postCount: number;
}

export type ShowPhase = "ready" | "spinning" | "won";

/** One spin the page asked for: the winner was already drawn (see draw.ts); the stage only shows it. */
export interface SpinRequest {
  id: number;
  winnerIndex: number;
}

export interface LotteryStageProps {
  /** In wheel order. */
  entrants: StageEntrant[];
  /** Members who didn't post: the crowd off stage. */
  audience: StagePerson[];
  phase: ShowPhase;
  spin: SpinRequest | null;
  reducedMotion: boolean;
  /** Called once the wheel has come to rest for spin `id`. */
  onSpinEnd: (id: number) => void;
  /** Accessible description of the scene. */
  label: string;
  /** Pixels at the bottom covered by the page's control bar; the camera frames the scene above it. */
  bottomInset?: number;
}

/**
 * Mutable state the scene's parts read every frame (kept out of React so a spin doesn't re-render
 * 80 characters 60 times a second).
 */
export interface Show {
  phase: ShowPhase;
  /** Seconds (scene clock) when the current phase began. */
  since: number;
  /** 0..1 through the current spin; 1 when not spinning. */
  progress: number;
  /** The wheel's current rotation, radians. */
  rotation: number;
  /** Radians per second, for the pointer flap and the bulbs. */
  speed: number;
  winnerId: number | null;
  /** Where the winner stands right now (they step forward to the front once they win), so
   * everyone else can turn to them and the spotlight and camera can follow. */
  winnerX: number;
  winnerY: number;
  winnerZ: number;
  /**
   * Hop beats, in whole hops, accumulated frame by frame (`beat += dt * hopsPerSecond`) while the
   * wheel spins: the stage avatars' and the crowd's. Their hops speed up as the wheel slows; reading
   * the phase off the scene clock with a changing period (`(t % period) / period`) instead made the
   * rate jump by `t * |dperiod/dt| / period^2`, which grows the longer the page has been open.
   */
  hopBeat: number;
  crowdBeat: number;
  reducedMotion: boolean;
}
