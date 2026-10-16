/* eslint-disable no-process-env */

/* Build the editor bundle for the desktop app.
 *
 * Same as `dist:min`, but written to `dist-desktop/iD.min.js` with the
 * preset and name-suggestion data addressed relative to the page, so the
 * packaged app serves them from its own `dist/` copy instead of a CDN.
 * (A plain `VAR=value node …` script line would not run on Windows.)
 */
import fs from 'node:fs';

process.env.ID_PRESETS_CDN_URL = process.env.ID_PRESETS_CDN_URL || 'tagging-schema/';
process.env.ID_NSI_CDN_URL = process.env.ID_NSI_CDN_URL || 'nsi/';

fs.mkdirSync('dist-desktop', { recursive: true });
process.argv = [process.argv[0], process.argv[1], '--outfile', 'dist-desktop/iD.min.js'];

await import('../config/esbuild.config.min.js');
