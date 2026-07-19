import { select as d3_select } from 'd3-selection';


describe('iD.rendererBackground BetteriD layers', function() {
    let background, container, context, surface;

    beforeEach(function() {
        container = d3_select('body').append('div');
        surface = d3_select('body')
            .append('div')
            .attr('class', 'background-surface');
        context = iD.coreContext().assetPath('../dist/').init().container(container);
        container.append('div')
            .attr('class', 'main-map')
            .call(context.map());
        context.map().dimensions([1000, 800]).centerZoom([0, 0], 16);
        background = context.background();
    });

    afterEach(function() {
        container.remove();
        surface.remove();
    });

    it('renders a second imagery source with independent opacity', function() {
        const source = iD.rendererBackgroundSource({
            id: 'betterid-secondary-test',
            name: 'Secondary test imagery',
            template: 'https://example.com/{z}/{x}/{y}.png',
            type: 'tms'
        });

        background.secondaryLayerSource(source);
        background.secondaryOpacity(0.35);
        surface.call(background);

        const secondary = surface.select('.layer-secondary-background');
        expect(secondary.size()).toEqual(1);
        expect(secondary.style('opacity')).toEqual('0.35');
        expect(background.secondaryLayerSource()).toBe(source);
        expect(background.secondaryOpacity()).toEqual(0.35);
    });

    it('keeps the custom editor visible when its saved URL is blocked', function() {
        const custom = background.findSource('custom');
        const none = background.findSource('none');
        custom.template('https://online0.map.bdimg.com/tile/?x={x}&y={y}&z={z}');
        context.connection = () => ({ imageryBlocklists: () => [/\.map\.bdimg\.com\//i] });

        const sources = background.sources(iD.geoExtent([-180, -90], [180, 90]));
        expect(sources).toContain(custom);

        background.baseLayerSource(custom);
        expect(background.baseLayerSource()).toBe(none);
    });

    it('moves, scales, and rotates an adjustable local photo', function() {
        const photo = {
            url: 'data:image/jpeg;base64,AA==',
            anchor: [0, 0],
            zoom: 16,
            width: 200,
            height: 100,
            opacity: 0.7,
            scale: 1,
            rotation: 0,
            adjust: true
        };

        background.localPhoto(photo);
        surface.call(background);

        const image = surface.select('.layer-local-photo img');
        expect(image.size()).toEqual(1);
        expect(image.style('width')).toEqual('200px');
        expect(image.style('opacity')).toEqual('0.7');
        expect(image.style('transform')).toContain('rotate(0deg)');

        const scaleEvent = new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaY: -100
        });
        image.node().dispatchEvent(scaleEvent);
        expect(scaleEvent.defaultPrevented).toBe(true);
        expect(photo.scale).toBeGreaterThan(1);

        const rotateEvent = new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaY: 100,
            shiftKey: true
        });
        image.node().dispatchEvent(rotateEvent);
        expect(photo.rotation).toEqual(2);

        const before = context.projection(photo.anchor);
        const down = pointerEvent('pointerdown', 7, 100, 120);
        image.node().dispatchEvent(down);
        window.dispatchEvent(pointerEvent('pointermove', 7, 150, 150));
        window.dispatchEvent(pointerEvent('pointerup', 7, 150, 150));
        const after = context.projection(photo.anchor);

        expect(after[0] - before[0]).toBeCloseTo(50, 6);
        expect(after[1] - before[1]).toBeCloseTo(30, 6);
    });

    function pointerEvent(type, pointerId, clientX, clientY) {
        const event = new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX,
            clientY
        });
        Object.defineProperty(event, 'pointerId', { value: pointerId });
        return event;
    }
});
