import { select as d3_select } from 'd3-selection';

import { actionAddEntity } from '../actions/add_entity';
import { actionOrthogonalize } from '../actions/orthogonalize';
import {
    aiAnalyzeImage, aiProvider, directAiAvailable, directAiImageAvailable, directAiImageEdit, directAiModel
} from '../core/betterid_ai';
import { prefs } from '../core/preferences';
import { t } from '../core/localizer';
import { geoRawMercator } from '../geo/raw_mercator';
import { modeSelect } from '../modes/select';
import { osmNode, osmWay } from '../osm';
import { svgIcon } from '../svg';
import { captureImagery } from '../util/betterid_imagery';
import { alignmentScore, parseVisionPolygons, polygonArea, traceOutlines } from '../util/betterid_trace';
import { uiTooltip } from './tooltip';


export const BETTERID_TRACE_METHOD_PREF = 'betterid.trace.method';
export const BETTERID_TRACE_FEATURE_PREF = 'betterid.trace.feature';

export const TRACE_METHODS = Object.freeze(['outline', 'vision']);

/** What the traced shapes become. */
export const TRACE_FEATURES = Object.freeze({
    building: { tags: { building: 'yes' }, square: true, subject: 'buildings (roof footprints)' },
    water: { tags: { natural: 'water' }, square: false, subject: 'water bodies (ponds, lakes, pools, reservoirs)' },
    wood: { tags: { natural: 'wood' }, square: false, subject: 'wooded areas (tree cover)' },
    parking: { tags: { amenity: 'parking' }, square: true, subject: 'car parking lots' },
    grass: { tags: { landuse: 'grass' }, square: false, subject: 'lawns and grass fields' }
});

const MAX_SEND_PX = 1024;          // longest side sent to the model
const OPENAI_SIZES = [[1024, 1024], [1536, 1024], [1024, 1536]];
const MIN_AREA_M2 = 6;
const ALIGNMENT_WARNING = 0.55;


function method() {
    const value = prefs(BETTERID_TRACE_METHOD_PREF);
    return TRACE_METHODS.includes(value) ? value : 'outline';
}

function feature() {
    const value = prefs(BETTERID_TRACE_FEATURE_PREF);
    return TRACE_FEATURES[value] ? value : 'building';
}


export function outlinePrompt(subject) {
    return 'This is an aerial / satellite photo. Draw a thin, solid, pure red (#FF0000) line exactly along ' +
        `the outer edge of every one of these: ${subject}. Each outline must be a closed loop. ` +
        'Do not change, move, recolour, crop, blur or redraw anything else: the output must be the very same ' +
        'photo, same size and alignment, with only the red outlines added. No fill, no text, no labels, ' +
        'no other colours or marks.';
}


export function visionPrompt(subject, width, height) {
    return `This is a ${width}x${height} pixel aerial / satellite photo (origin top-left, x to the right, y down). ` +
        `List the outlines of every one of these that is clearly visible: ${subject}. ` +
        'Return only JSON of the form {"buildings":[{"polygon":[[x,y],[x,y],...]}]} with pixel coordinates, ' +
        '4 to 16 vertices per polygon following the real edges, no repeated closing point, nothing else.';
}


/**
 * "AI trace": outline the features in the visible imagery with an image model
 * (red strokes) or a vision model (pixel polygons) and turn them into OSM
 * areas the mapper can review, fix and upload.
 *
 * The map projection is frozen when the imagery is captured, so panning away
 * while the model works does not misplace the result.
 */
export function uiBetteridAiTrace(context) {
    let _open = false;
    let _running = false;
    let _status = null;      // { kind: 'info'|'ok'|'warn'|'error', text }
    let _container = d3_select(null);
    let _abort = null;


    function available() {
        if (!directAiAvailable()) return 'provider';
        if (method() === 'outline' && !directAiImageAvailable()) return 'image_model';
        if (method() === 'vision' && !directAiModel('vision')) return 'vision_model';
        return null;
    }


    /* ------------------------------------------------------------ imagery -- */

    function toDataURL(canvas) {
        return canvas.toDataURL('image/png');
    }

    function loadImage(url) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            if (!/^data:/.test(url)) image.crossOrigin = 'anonymous';
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error(t('betterid.trace.error_image')));
            image.src = url;
        });
    }

    /**
     * The picture that goes to the model: the capture scaled to fit the
     * longest side, padded to one of the fixed sizes the Images API accepts.
     * Returns the frame needed to map a result pixel back to a capture pixel.
     */
    function prepareUpload(sheet) {
        const ai = aiProvider();
        const scale = Math.min(1, MAX_SEND_PX / Math.max(sheet.width, sheet.height));
        const drawW = Math.round(sheet.width * scale);
        const drawH = Math.round(sheet.height * scale);

        let outW = drawW;
        let outH = drawH;
        if (method() === 'outline' && ai && ai.imageApi === 'images') {
            const aspect = drawW / drawH;
            const size = aspect > 1.2 ? OPENAI_SIZES[1] : aspect < 0.83 ? OPENAI_SIZES[2] : OPENAI_SIZES[0];
            [outW, outH] = size;
        }
        // fit inside the output and centre it
        const fit = Math.min(outW / drawW, outH / drawH, 1);
        const fitW = Math.round(drawW * fit);
        const fitH = Math.round(drawH * fit);
        const offsetX = Math.floor((outW - fitW) / 2);
        const offsetY = Math.floor((outH - fitH) / 2);

        const canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#7f7f7f';
        ctx.fillRect(0, 0, outW, outH);
        ctx.drawImage(sheet.canvas, 0, 0, sheet.width, sheet.height, offsetX, offsetY, fitW, fitH);

        return {
            canvas,
            width: outW,
            height: outH,
            // result pixel -> capture pixel
            toCapture: ([x, y]) => [
                (x - offsetX) / fitW * sheet.width,
                (y - offsetY) / fitH * sheet.height
            ],
            imageData: ctx.getImageData(0, 0, outW, outH)
        };
    }

    /** Draw whatever the model returned at the size we sent. */
    async function resultImageData(url, width, height) {
        const image = await loadImage(url);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0, width, height);
        return ctx.getImageData(0, 0, width, height);
    }


    /* ------------------------------------------------------------ geometry -- */

    /** Build the OSM entities for the traced polygons; one undo step. */
    function commit(polygons, snapshot, upload) {
        const kind = TRACE_FEATURES[feature()];
        const actions = [];
        const wayIDs = [];
        const metersPerPixel = (() => {
            const a = snapshot.invert([0, 0]);
            const b = snapshot.invert([1, 0]);
            return Math.abs(b[0] - a[0]) * 111320 * Math.cos(a[1] * Math.PI / 180);
        })();

        polygons.forEach(polygon => {
            const capturePoints = polygon.points.map(upload.toCapture);
            const areaM2 = Math.abs(polygonArea(capturePoints)) * metersPerPixel * metersPerPixel;
            if (areaM2 < MIN_AREA_M2) return;

            const nodes = capturePoints.map(p => new osmNode({ loc: snapshot.invert(p) }));
            if (nodes.length < 3) return;
            const way = new osmWay({ nodes: nodes.map(n => n.id).concat([nodes[0].id]), tags: Object.assign({}, kind.tags) });

            nodes.forEach(node => actions.push(actionAddEntity(node)));
            actions.push(actionAddEntity(way));
            if (kind.square) {
                // buildings and car parks are usually rectangular: square them
                // up when the shape is close enough for iD's own operation
                actions.push(g => {
                    const square = actionOrthogonalize(way.id, context.projection);
                    return square.disabled(g) ? g : square(g);
                });
            }
            wayIDs.push(way.id);
        });

        if (!wayIDs.length) return 0;
        context.perform(...actions, t('betterid.trace.annotation', { count: wayIDs.length }));
        const created = wayIDs.filter(id => context.hasEntity(id));
        if (created.length) context.enter(modeSelect(context, created));
        return created.length;
    }


    /* ---------------------------------------------------------------- run -- */

    /* eslint-disable require-atomic-updates */
    async function run() {
        if (_running) return;
        const missing = available();
        if (missing) {
            setStatus('error', t('betterid.trace.missing_' + missing));
            return;
        }
        if (!context.map().withinEditableZoom()) {
            setStatus('error', t('betterid.trace.zoom_in'));
            return;
        }

        _running = true;
        _abort = new AbortController();
        setStatus('info', t('betterid.trace.capturing'));

        try {
            const sheet = await captureImagery(context);
            if (!sheet) throw new Error(t('betterid.tools.imagery_unreadable'));

            // freeze the view: the user may pan while the model works
            const snapshot = geoRawMercator().transform(context.projection.transform());
            const upload = prepareUpload(sheet);
            const subject = TRACE_FEATURES[feature()].subject;
            let polygons;
            let alignment = 1;

            setStatus('info', t('betterid.trace.asking', { model: directAiModel(method() === 'outline' ? 'image' : 'vision') }));

            if (method() === 'outline') {
                const url = await directAiImageEdit({
                    image: toDataURL(upload.canvas),
                    prompt: outlinePrompt(subject),
                    size: `${upload.width}x${upload.height}`,
                    signal: _abort.signal
                });
                const edited = await resultImageData(url, upload.width, upload.height);
                alignment = alignmentScore(upload.imageData, edited);
                polygons = traceOutlines(edited, { tolerance: 1.25 });
            } else {
                const answer = await aiAnalyzeImage(toDataURL(upload.canvas),
                    visionPrompt(subject, upload.width, upload.height), { signal: _abort.signal, maxTokens: 4096 });
                polygons = parseVisionPolygons(answer, upload.width, upload.height);
            }

            const count = commit(polygons, snapshot, upload);
            if (!count) {
                setStatus('warn', t('betterid.trace.nothing'));
            } else if (alignment < ALIGNMENT_WARNING) {
                setStatus('warn', t('betterid.trace.done_misaligned', { count }));
            } else {
                setStatus('ok', t('betterid.trace.done', { count }));
            }
        } catch (error) {
            if (error && error.name === 'AbortError') {
                setStatus('info', t('betterid.trace.cancelled'));
            } else {
                setStatus('error', t('betterid.trace.failed', { message: (error && error.message) || String(error) }));
            }
        } finally {
            _running = false;
            _abort = null;
            render();
        }
    }
    /* eslint-enable require-atomic-updates */

    function cancel() {
        if (_abort) _abort.abort();
    }

    function setStatus(kind, text) {
        _status = { kind, text };
        render();
    }


    /* ------------------------------------------------------------ rendering -- */

    function render() {
        if (_container.empty()) return;

        _container.select('.betterid-ai-trace-button')
            .classed('active', _open)
            .classed('running', _running);

        let panel = _container.selectAll('.betterid-ai-trace-panel').data(_open ? [0] : []);
        panel.exit().remove();
        const panelEnter = panel.enter().append('div')
            .attr('class', 'betterid-tool-options betterid-ai-trace-panel');

        panelEnter.append('h4').call(t.append('betterid.trace.title'));

        const methodRow = panelEnter.append('label').attr('class', 'betterid-tool-option');
        methodRow.append('span').attr('class', 'betterid-tool-option-label').call(t.append('betterid.trace.method'));
        const methodSelect = methodRow.append('select')
            .attr('class', 'betterid-ai-trace-method')
            .on('change', function() { prefs(BETTERID_TRACE_METHOD_PREF, this.value); _status = null; render(); });
        methodSelect.selectAll('option').data(TRACE_METHODS).enter().append('option')
            .attr('value', d => d)
            .each(function(d) { d3_select(this).call(t.append('betterid.trace.method_' + d)); });

        const featureRow = panelEnter.append('label').attr('class', 'betterid-tool-option');
        featureRow.append('span').attr('class', 'betterid-tool-option-label').call(t.append('betterid.trace.feature'));
        const featureSelect = featureRow.append('select')
            .attr('class', 'betterid-ai-trace-feature')
            .on('change', function() { prefs(BETTERID_TRACE_FEATURE_PREF, this.value); render(); });
        featureSelect.selectAll('option').data(Object.keys(TRACE_FEATURES)).enter().append('option')
            .attr('value', d => d)
            .each(function(d) { d3_select(this).call(t.append('betterid.trace.feature_' + d)); });

        const buttons = panelEnter.append('div').attr('class', 'betterid-ai-trace-actions');
        buttons.append('button')
            .attr('type', 'button')
            .attr('class', 'action betterid-ai-trace-run')
            .on('click', d3_event => { d3_event.preventDefault(); run(); });
        buttons.append('button')
            .attr('type', 'button')
            .attr('class', 'betterid-ai-trace-cancel')
            .call(t.append('betterid.trace.cancel'))
            .on('click', d3_event => { d3_event.preventDefault(); cancel(); });

        panelEnter.append('p').attr('class', 'betterid-ai-trace-status');
        panelEnter.append('p').attr('class', 'betterid-tool-hint').call(t.append('betterid.trace.help'));

        panel = panelEnter.merge(panel);
        if (panel.empty()) return;

        panel.select('.betterid-ai-trace-method').property('value', method()).property('disabled', _running);
        panel.select('.betterid-ai-trace-feature').property('value', feature()).property('disabled', _running);

        const missing = available();
        panel.select('.betterid-ai-trace-run')
            .property('disabled', _running || Boolean(missing))
            .text(t('betterid.trace.run'));
        panel.select('.betterid-ai-trace-cancel').style('display', _running ? null : 'none');

        const status = panel.select('.betterid-ai-trace-status');
        if (_status) {
            status.attr('class', 'betterid-ai-trace-status ' + _status.kind).text(_status.text);
        } else if (missing) {
            status.attr('class', 'betterid-ai-trace-status warn').text(t('betterid.trace.missing_' + missing));
        } else {
            status.attr('class', 'betterid-ai-trace-status').text(t('betterid.trace.ready'));
        }
    }


    /** The palette entry: a button under the tools, with its panel beside it. */
    function trace(selection) {
        _container = selection;
        selection.append('div').attr('class', 'betterid-tool-divider');
        selection.append('button')
            .attr('type', 'button')
            .attr('class', 'betterid-tool-button betterid-ai-trace-button')
            .on('click', d3_event => {
                d3_event.preventDefault();
                _open = !_open;
                render();
            })
            .call(svgIcon('#iD-icon-betterid-aitrace'))
            .call(uiTooltip()
                .placement('right')
                .title(() => t.append('betterid.trace.title'))
                .scrollContainer(context.container().select('.over-map')));
        render();
    }

    trace.run = run;
    trace.open = function(value) {
        if (!arguments.length) return _open;
        _open = Boolean(value);
        render();
        return trace;
    };

    return trace;
}
