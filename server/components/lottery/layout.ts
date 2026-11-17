// Where everything stands. Pure numbers (world units, y up, the camera looks down -z), so the
// scene components only draw.
//
//   wheel (back, raised)  ─ the prize wheel on its stand
//   stage rows            ─ entrants, each on their own board-game space; back rows on higher tiers
//   floor in front        ─ the audience (members who didn't post), smaller, facing the stage

export interface Spot {
  x: number;
  y: number; // the surface the feet stand on
  z: number;
  row: number;
  /** Position within the row, left to right. */
  col: number;
  /** Labels in a crowded row alternate between two heights so neighbours don't collide. */
  labelLift: number;
}

export interface Layout {
  stage: Spot[];
  audience: Spot[];
  /** Avatar scale on stage (shrinks a little when the stage is full). */
  stageScale: number;
  audienceScale: number;
  crowded: boolean;
  /** The board: top surface height and its footprint. */
  board: { top: number; minX: number; maxX: number; minZ: number; maxZ: number };
  /** Each stage row's tier: its tiles' top height and row depth. */
  rows: { z: number; top: number; width: number }[];
  wheel: { x: number; y: number; z: number; radius: number };
  /** Points the camera must keep in view (row ends with their labels, wheel, board, crowd). */
  frame: [number, number, number][];
  spacing: number;
}

const BOARD_TOP = 0.45;
const TIER = 0.78;
const ROW_GAP = 1.5;
const FRONT_Z = 1.4;
const AVATAR_HEIGHT = 1.55; // feet to the top of a typical head, at scale 1

/** Split `n` people into `rows` rows, the extra ones going to the back (wider, higher) rows. */
function rowCounts(n: number, rows: number): number[] {
  const base = Math.floor(n / rows);
  const extra = n % rows;
  return Array.from({ length: rows }, (_, r) => base + (r >= rows - extra ? 1 : 0));
}

function stageRowsFor(n: number): number {
  if (n <= 7) return 1;
  if (n <= 18) return 2;
  if (n <= 42) return 3;
  return Math.ceil(n / 14);
}

export function layoutFor(entrantCount: number, audienceCount: number): Layout {
  const crowded = entrantCount > 16;
  const stageScale = entrantCount > 30 ? 0.82 : entrantCount > 16 ? 0.9 : 1;
  const spacing = entrantCount > 30 ? 1.12 : entrantCount > 16 ? 1.25 : 1.45;
  const rowsN = entrantCount === 0 ? 1 : stageRowsFor(entrantCount);
  const counts = entrantCount === 0 ? [0] : rowCounts(entrantCount, rowsN);

  const stage: Spot[] = [];
  const rows: Layout["rows"] = [];
  counts.forEach((count, row) => {
    const z = FRONT_Z - row * ROW_GAP;
    const top = BOARD_TOP + 0.16 + row * TIER;
    rows.push({ z, top, width: Math.max(count, 1) * spacing });
    for (let col = 0; col < count; col++) {
      const x = (col - (count - 1) / 2) * spacing;
      stage.push({ x, y: top, z, row, col, labelLift: crowded && col % 2 === 1 ? 0.34 : 0 });
    }
  });

  const backRow = rows[rows.length - 1];
  const widest = Math.max(...rows.map((r) => r.width), 3);
  const radius = entrantCount > 24 ? 3.3 : entrantCount > 12 ? 3.0 : 2.7;
  const wheelZ = backRow.z - 1.7;
  // Just clear the back row's heads; its labels may overlap the lower rim, never the pointer.
  const wheelY = backRow.top + AVATAR_HEIGHT * stageScale + 0.35 + radius;

  const board = {
    top: BOARD_TOP,
    minX: -Math.max(widest / 2 + 1.0, radius + 1.4),
    maxX: Math.max(widest / 2 + 1.0, radius + 1.4),
    minZ: wheelZ - 1.1,
    maxZ: FRONT_Z + 1.0,
  };

  // The audience: on the floor in front of the board, rows of up to 16, facing the stage.
  const audience: Spot[] = [];
  const audienceScale = 0.58;
  const aSpacing = 0.78;
  const perRow = Math.max(8, Math.min(16, Math.ceil((board.maxX - board.minX) / aSpacing)));
  const aRows = Math.ceil(audienceCount / perRow);
  const aCounts = aRows === 0 ? [] : rowCounts(audienceCount, aRows).reverse(); // fuller rows nearest the stage
  aCounts.forEach((count, row) => {
    const z = board.maxZ + 0.9 + row * 0.8;
    for (let col = 0; col < count; col++) {
      // Every other row is offset by half a place, like real seating, so heads peek through.
      const x = (col - (count - 1) / 2) * aSpacing + (row % 2 ? aSpacing / 2 : 0);
      audience.push({ x, y: 0, z, row, col, labelLift: 0 });
    }
  });

  const frame: [number, number, number][] = [];
  const headroom = AVATAR_HEIGHT * stageScale + 0.75; // head, hat and name tag
  rows.forEach((r) => {
    const half = r.width / 2;
    frame.push([-half, r.top, r.z], [half, r.top, r.z], [-half, r.top + headroom, r.z], [half, r.top + headroom, r.z]);
  });
  frame.push([board.minX, board.top, board.maxZ], [board.maxX, board.top, board.maxZ], [board.minX, 0, board.maxZ], [board.maxX, 0, board.maxZ]);
  frame.push([board.minX + 0.35, board.top + 3.3, board.maxZ - 0.35], [board.maxX - 0.35, board.top + 3.3, board.maxZ - 0.35]); // balloons
  if (entrantCount > 0) {
    frame.push([-radius - 0.6, wheelY, wheelZ], [radius + 0.6, wheelY, wheelZ], [0, wheelY + radius + 1.0, wheelZ]);
  }
  for (const a of audience) frame.push([a.x, 0, a.z], [a.x, AVATAR_HEIGHT * audienceScale, a.z]);

  return {
    stage,
    audience,
    stageScale,
    audienceScale,
    crowded,
    board,
    rows,
    wheel: { x: 0, y: wheelY, z: wheelZ, radius },
    frame,
    spacing,
  };
}
