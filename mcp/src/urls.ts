export interface MapViewInput {
  lat: number;
  lon: number;
  zoom: number;
}

/** Build a BetteriD editor URL with an optional `#map=zoom/lat/lon` hash. */
export function buildEditorUrl(baseUrl: string, path: string, view?: MapViewInput): string {
  const root = baseUrl.replace(/\/+$/, '');
  const editorPath = path.startsWith('/') ? path : `/${path}`;
  const hash = view
    ? `#map=${view.zoom.toFixed(2)}/${view.lat.toFixed(6)}/${view.lon.toFixed(6)}`
    : '';
  return `${root}${editorPath}${hash}`;
}
