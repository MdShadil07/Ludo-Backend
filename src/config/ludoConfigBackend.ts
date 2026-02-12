/**
 * LUDO BOARD CONFIGURATION - BACKEND VERSION
 * This configuration is independent of the frontend's ludoConfig.ts
 * Supports 2-6 players
 */

export type PlayerColor = 'red' | 'green' | 'yellow' | 'blue' | 'purple' | 'orange' | 'white' | 'black';
export type TokenStatus = 'base' | 'active' | 'safe' | 'home' | 'finished';
export const ALL_PLAYER_COLORS: PlayerColor[] = ['red', 'green', 'yellow', 'blue', 'purple', 'orange', 'white', 'black'];

export interface Token {
  id: number; // Unique identifier for the token (e.g., 0, 1, 2, 3)
  color: PlayerColor;
  status: TokenStatus;
  position: number; // -1: Base, 0-51: Main Track, 52-57: Home Run, 58: Center/Home
  steps: number; // Total steps taken
}

export interface PlayerConfig {
  id: PlayerColor;
  name: string;
  color: {
    primary: string;
    secondary: string;
    accent: string;
    hex: string;
  };
  homeStart: number; // Starting index on main track (0, 13, 26, 39, ...)
  direction: number; // Angle in degrees for board orientation (0, 90, 180, 270, ...)
  baseCoords: { r: number, c: number }; // Top-left corner of the 6x6 base grid
  homeEntranceCoord: [number, number]; // Coordinate where tokens enter the home run
  homeRunCoords: [number, number][]; // Coordinates of the 6 cells in the home run
}

// Comprehensive configuration for all possible players (up to 8)
export const ALL_PLAYER_DETAILS: PlayerConfig[] = [
  {
    id: 'red',
    name: 'Red',
    color: {
      primary: '#D32F2F',
      secondary: '#FFCDD2',
      accent: '#B71C1C',
      hex: '#D32F2F',
    },
    homeStart: 0,
    direction: 0,
    baseCoords: { r: 0, c: 0 },
    homeEntranceCoord: [6,1],
    homeRunCoords: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6]],
  },
  {
    id: 'green',
    name: 'Green',
    color: {
      primary: '#388E3C',
      secondary: '#C8E6C9',
      accent: '#1B5E20',
      hex: '#388E3C',
    },
    homeStart: 13,
    direction: 90,
    baseCoords: { r: 0, c: 9 },
    homeEntranceCoord: [1,8],
    homeRunCoords: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7]],
  },
  {
    id: 'yellow',
    name: 'Yellow',
    color: {
      primary: '#FBC02D',
      secondary: '#FFF9C4',
      accent: '#F57F17',
      hex: '#FBC02D',
    },
    homeStart: 26,
    direction: 180,
    baseCoords: { r: 9, c: 9 },
    homeEntranceCoord: [8,13],
    homeRunCoords: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], [7, 8]],
  },
  {
    id: 'blue',
    name: 'Blue',
    color: {
      primary: '#1976D2',
      secondary: '#BBDEFB',
      accent: '#0D47A1',
      hex: '#1976D2',
    },
    homeStart: 39,
    direction: 270,
    baseCoords: { r: 9, c: 0 },
    homeEntranceCoord: [13,6],
    homeRunCoords: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7], [8, 7]],
  },
  // Additional players for 6 or 8 player games (example configurations - adjust as per board design)
  {
    id: 'purple',
    name: 'Purple',
    color: {
      primary: '#6A1B9A',
      secondary: '#E1BEE7',
      accent: '#4A148C',
      hex: '#6A1B9A',
    },
    homeStart: 6, // Example track position
    direction: 45, // Example direction
    baseCoords: { r: 3, c: 0 }, // Example base position
    homeEntranceCoord: [6,4], // Example
    homeRunCoords: [[6, 5], [5, 5], [4, 5], [3, 5], [2, 5], [1, 5]], // Example
  },
  {
    id: 'orange',
    name: 'Orange',
    color: {
      primary: '#EF6C00',
      secondary: '#FFECB3',
      accent: '#E65100',
      hex: '#EF6C00',
    },
    homeStart: 32, // Example track position
    direction: 225, // Example direction
    baseCoords: { r: 9, c: 3 }, // Example base position
    homeEntranceCoord: [8,10], // Example
    homeRunCoords: [[9, 9], [9, 10], [9, 11], [9, 12], [9, 13], [9, 14]], // Example
  },
  // You can add more for white/black if you plan 8 players
];

// Mapping player counts to specific player IDs/colors and their board positions
export const PLAYER_COLOR_MAPS: Record<number, PlayerColor[]> = {
  2: ['red', 'yellow'], // Red and Yellow (opposite corners)
  3: ['red', 'green', 'blue'], // Red, Green, Blue
  4: ['red', 'green', 'yellow', 'blue'], // All four corners
  5: ['red', 'green', 'yellow', 'blue', 'orange'], // 4 corners + 1 side
  6: ['red', 'green', 'yellow', 'blue', 'purple', 'orange'], // 4 corners + 2 sides
};

export interface GameConfig {
  players: PlayerConfig[];
  BASES: Record<PlayerColor, { r: number, c: number }>;
  START_POSITIONS: Record<PlayerColor, number>;
  HOME_ENTRANCES: Record<PlayerColor, [number, number]>;
  HOME_RUNS: Record<PlayerColor, [number, number][]>;
  TRACK_HIGHLIGHT_CELLS: Record<string, PlayerColor>; // New for dynamic track coloring
}

const createColorRecord = <T>(initializer: (color: PlayerColor) => T): Record<PlayerColor, T> => ({
  red: initializer('red'),
  green: initializer('green'),
  yellow: initializer('yellow'),
  blue: initializer('blue'),
  purple: initializer('purple'),
  orange: initializer('orange'),
  white: initializer('white'),
  black: initializer('black'),
});

export const getGameConfig = (numPlayers: number): GameConfig => {
  const activePlayerColors = PLAYER_COLOR_MAPS[numPlayers] || PLAYER_COLOR_MAPS[4]; // Default to 4 players
  const playersConfig = ALL_PLAYER_DETAILS.filter(p => activePlayerColors.includes(p.id));

  const BASES = createColorRecord(() => ({ r: 0, c: 0 }));
  const START_POSITIONS = createColorRecord(() => 0);
  const HOME_ENTRANCES = createColorRecord(() => [0, 0] as [number, number]);
  const HOME_RUNS = createColorRecord(() => [] as [number, number][]);
  const TRACK_HIGHLIGHT_CELLS: Record<string, PlayerColor> = {};

  playersConfig.forEach(player => {
    BASES[player.id] = player.baseCoords;
    START_POSITIONS[player.id] = player.homeStart;
    HOME_ENTRANCES[player.id] = player.homeEntranceCoord;
    HOME_RUNS[player.id] = player.homeRunCoords;

    // Dynamically set track highlight cells based on homeEntranceCoord
    TRACK_HIGHLIGHT_CELLS[`${player.homeEntranceCoord[0]}-${player.homeEntranceCoord[1]}`] = player.id;

    // Add main track entrance cells based on START_POSITIONS for dynamic coloring
    const startCoord = TRACK_COORDS[player.homeStart];
    if (startCoord) {
      TRACK_HIGHLIGHT_CELLS[`${startCoord[0]}-${startCoord[1]}`] = player.id;
    }
  });

  return {
    players: playersConfig,
    BASES,
    START_POSITIONS,
    HOME_ENTRANCES,
    HOME_RUNS,
    TRACK_HIGHLIGHT_CELLS,
  };
};

// Fixed track coordinates for a 15x15 board
export const TRACK_COORDS: [number, number][] = [
    [6, 1], [6, 2], [6, 3], [6, 4], [6, 5],
    [5, 6], [4, 6], [3, 6], [2, 6], [1, 6],
    [0, 6], [0, 7], [0, 8],
    [1, 8], [2, 8], [3, 8], [4, 8], [5, 8],
    [6, 9], [6, 10], [6, 11], [6, 12], [6, 13],
    [6, 14], [7, 14], [8, 14],
    [8, 13], [8, 12], [8, 11], [8, 10], [8, 9],
    [9, 8], [10, 8], [11, 8], [12, 8], [13, 8],
    [14, 8], [14, 7], [14, 6],
    [13, 6], [12, 6], [11, 6], [10, 6], [9, 6],
    [8, 5], [8, 4], [8, 3], [8, 2], [8, 1],
    [8, 0], [7, 0], [6, 0]
];

// Indices on the main track (0-51) that are safe from capture
// Includes starting positions and star positions
export const SAFE_INDICES = [
  0,  // Red Start
  8,  // Red Safe Star
  13, // Green Start
  21, // Green Safe Star
  26, // Yellow Start
  34, // Yellow Safe Star
  39, // Blue Start
  47  // Blue Safe Star
];
