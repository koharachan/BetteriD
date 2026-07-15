import { select as d3_select } from 'd3-selection';

describe('iD.uiInspector', function () {
    it('renders safely before entity IDs are assigned', async () => {
        await iD.presetManager.ensureLoaded(true);

        const container = d3_select(document.createElement('div'));
        const selection = container.append('div');
        const context = iD.coreContext().assetPath('../dist/').init().container(container);
        const inspector = iD.uiInspector(context);

        expect(() => inspector(selection)).not.toThrow();
    });
});
