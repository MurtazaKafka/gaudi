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
  mono: "'IBM Plex Mono', monospace",
} as const;
