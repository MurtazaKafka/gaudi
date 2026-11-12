/** Canvas (konva/three) can't read CSS variables — keep these in sync with index.css. */
export const theme = {
  paper: '#F5F2EB',
  surface: '#FCFBF8',
  ink: '#211F1B',
  inkSoft: '#6B675E',
  line: '#E3DFD4',
  gridMinor: 'rgba(33, 31, 27, 0.05)',
  gridMajor: 'rgba(33, 31, 27, 0.10)',
  gridAxis: 'rgba(33, 31, 27, 0.20)',
  accent: '#C14E33',
  accentSoft: 'rgba(193, 78, 51, 0.12)',
  roomFill: 'rgba(33, 31, 27, 0.045)',
  /** "can't go here" on the plan (the accent already means "selected") */
  invalid: '#B4332A',
  invalidSoft: 'rgba(180, 51, 42, 0.14)',
  /** furniture linework, and a wall under the pointer */
  furnitureLine: '#8D8779',
  inkHover: '#4A463E',
  mono: "'IBM Plex Mono', monospace",
  /** Color look: the floor seen through a doorway, and window glass */
  threshold: '#F9F6EF',
  glass: '#D9E6EA',
  /** the faint wash inside a door's swing */
  swingFill: 'rgba(33, 31, 27, 0.05)',
  /** shadow the house casts on the paper, and furniture on the floor */
  houseShadow: 'rgba(74, 58, 34, 0.30)',
  itemShadow: 'rgba(56, 44, 28, 0.30)',
} as const;
