import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildEditorUrl } from '../src/urls.js';

test('buildEditorUrl appends editor path and map hash', () => {
  assert.equal(
    buildEditorUrl('http://127.0.0.1:9178/', '/id/', {
      lat: 30.5,
      lon: 120.1,
      zoom: 17
    }),
    'http://127.0.0.1:9178/id/#map=17.00/30.500000/120.100000'
  );
});

test('buildEditorUrl without view keeps plain editor path', () => {
  assert.equal(buildEditorUrl('https://map.osm.asia', '/id/'), 'https://map.osm.asia/id/');
});
