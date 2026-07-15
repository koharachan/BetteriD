import fetchMock from 'fetch-mock';

import { utilAIStatus, utilResetAIStatus } from '../../../modules/util/ai_status';

describe('utilAIStatus', function() {
    afterEach(function() {
        fetchMock.reset();
        utilResetAIStatus();
    });

    it('normalizes and caches the server status', async function() {
        fetchMock.mock('/api/osm-ai/status', {
            ai: true,
            translate: false
        });

        expect(await utilAIStatus()).toEqual({
            ai: true,
            translate: false
        });
        expect(await utilAIStatus()).toEqual({
            ai: true,
            translate: false
        });
        expect(fetchMock.calls()).toHaveLength(1);
    });

    it('disables AI features when the status request fails', async function() {
        fetchMock.mock('/api/osm-ai/status', 500);

        expect(await utilAIStatus()).toEqual({
            ai: false,
            translate: false
        });
    });

    it('treats non-boolean response values as disabled', async function() {
        fetchMock.mock('/api/osm-ai/status', { ai: 1, translate: 'yes' });

        expect(await utilAIStatus()).toEqual({
            ai: false,
            translate: false
        });
    });
});
