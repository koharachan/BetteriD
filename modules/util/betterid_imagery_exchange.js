/**
 * Satellite crop export and annotated re-import.
 *
 * The crop is a PNG with a `betterid-georef` tEXt chunk (and a copy of the
 * same JSON in preferences). Red closed strokes become buildings, green
 * closed strokes or fills become areas, placed with the saved map transform.
 */

import { actionAddEntity } from '../actions/add_entity';
import { actionOrthogonalize } from '../actions/orthogonalize';
import { t } from '../core/localizer';
import { prefs } from '../core/preferences';
import { geoRawMercator } from '../geo/raw_mercator';
import { osmNode, osmWay } from '../osm';
import { traceAnnotatedImage } from './betterid_trace';

export const LAST_GEOREF_PREF = 'betterid.imagery.georef';
export const GEOREF_KEYWORD = 'betterid-georef';


export function cropWindow(width, height, corners) {
    const pad = 8;
    const xs = corners.map(point => point[0]).filter(Number.isFinite);
    const ys = corners.map(point => point[1]).filter(Number.isFinite);
    if (!xs.length || !ys.length) return { x: 0, y: 0, width, height };
    const x1 = Math.max(0, Math.floor(Math.min(...xs)) - pad);
    const y1 = Math.max(0, Math.floor(Math.min(...ys)) - pad);
    const x2 = Math.min(width, Math.ceil(Math.max(...xs)) + pad);
    const y2 = Math.min(height, Math.ceil(Math.max(...ys)) + pad);
    if (x2 - x1 < 8 || y2 - y1 < 8) return { x: 0, y: 0, width, height };
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}


export function buildGeoref(transform, crop) {
    return {
        version: 1,
        width: crop.width,
        height: crop.height,
        offsetX: crop.x,
        offsetY: crop.y,
        transform: { k: transform.k, x: transform.x, y: transform.y }
    };
}


/** Remember the image size actually being imported, which may differ from the export. */
export function georefForImage(georef, imageWidth, imageHeight) {
    return Object.assign({}, georef, { imageWidth, imageHeight });
}


function projectionFor(georef) {
    return geoRawMercator().transform(georef.transform);
}


export function pixelToLoc(georef, x, y) {
    const scaleX = georef.width / (georef.imageWidth || georef.width);
    const scaleY = georef.height / (georef.imageHeight || georef.height);
    return projectionFor(georef).invert([x * scaleX + georef.offsetX, y * scaleY + georef.offsetY]);
}


export function locToPixel(georef, loc) {
    const point = projectionFor(georef)(loc);
    const scaleX = georef.width / (georef.imageWidth || georef.width);
    const scaleY = georef.height / (georef.imageHeight || georef.height);
    return [(point[0] - georef.offsetX) / scaleX, (point[1] - georef.offsetY) / scaleY];
}


export function featuresFromAnnotation(imageData, georef) {
    const traced = traceAnnotatedImage(imageData);
    const toLoc = points => points.map(([x, y]) => pixelToLoc(georef, x, y)).filter(loc => loc && Number.isFinite(loc[0]));
    return {
        buildings: traced.buildings.map(shape => ({ loc: toLoc(shape.points), tags: { building: 'yes' } })),
        areas: traced.areas.map(shape => ({ loc: toLoc(shape.points), tags: { area: 'yes' } }))
    };
}


export function commitAnnotatedFeatures(context, features) {
    const actions = [];
    const ids = [];
    [
        { items: features.buildings || [], square: true },
        { items: features.areas || [], square: false }
    ].forEach(group => {
        group.items.forEach(item => {
            if (!item.loc || item.loc.length < 3) return;
            const nodes = item.loc.map(loc => new osmNode({ loc: loc.slice() }));
            const way = new osmWay({
                nodes: nodes.map(node => node.id).concat(nodes[0].id),
                tags: Object.assign({}, item.tags)
            });
            nodes.forEach(node => actions.push(actionAddEntity(node)));
            actions.push(actionAddEntity(way));
            if (group.square && context.projection) {
                actions.push(graph => {
                    try {
                        const square = actionOrthogonalize(way.id, context.projection);
                        return square.disabled(graph) ? graph : square(graph);
                    } catch {
                        return graph;
                    }
                });
            }
            ids.push(way.id);
        });
    });
    if (!actions.length) return [];
    context.perform(...actions, t('betterid.tools.workflow.imagery_annotation', { count: ids.length }));
    return ids.filter(id => context.hasEntity(id));
}


export function rememberGeoref(georef) {
    prefs(LAST_GEOREF_PREF, JSON.stringify(georef));
}


export function rememberedGeoref() {
    try {
        const value = JSON.parse(prefs(LAST_GEOREF_PREF) || '');
        if (value && value.transform && value.width && value.height) return value;
    } catch { /* no saved frame */ }
    return null;
}


function crc32(bytes) {
    let crc = ~0;
    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i];
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return ~crc >>> 0;
}


function readU32(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}


function u32(value) {
    return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}


function pngChunks(bytes) {
    if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) return null;
    const chunks = [];
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const length = readU32(bytes, offset);
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        const end = offset + 12 + length;
        if (end > bytes.length) return null;
        chunks.push({ type, start: offset, end, data: bytes.subarray(offset + 8, offset + 8 + length) });
        offset = end;
        if (type === 'IEND') break;
    }
    return chunks;
}


function textChunk(keyword, text) {
    const data = [];
    for (let i = 0; i < keyword.length; i++) data.push(keyword.charCodeAt(i));
    data.push(0);
    for (let i = 0; i < text.length; i++) data.push(text.charCodeAt(i) & 255);
    const payload = Uint8Array.from(data);
    const type = [116, 69, 88, 116]; // tEXt
    const crc = crc32(Uint8Array.from([...type, ...payload]));
    return Uint8Array.from([...u32(payload.length), ...type, ...payload, ...u32(crc)]);
}


/** Insert a Latin-1 tEXt chunk before IEND. Returns a new PNG. */
export function embedPngText(pngBytes, keyword, text) {
    const chunks = pngChunks(pngBytes);
    if (!chunks || !chunks.length || chunks[chunks.length - 1].type !== 'IEND') {
        throw new Error('Not a PNG');
    }
    const iend = chunks[chunks.length - 1].start;
    const extra = textChunk(keyword, text);
    const out = new Uint8Array(pngBytes.length + extra.length);
    out.set(pngBytes.subarray(0, iend), 0);
    out.set(extra, iend);
    out.set(pngBytes.subarray(iend), iend + extra.length);
    return out;
}


export function readPngText(pngBytes, keyword) {
    const chunks = pngChunks(pngBytes);
    if (!chunks) return null;
    for (const chunk of chunks) {
        if (chunk.type !== 'tEXt') continue;
        const zero = chunk.data.indexOf(0);
        if (zero < 1) continue;
        const name = String.fromCharCode(...chunk.data.subarray(0, zero));
        if (name !== keyword) continue;
        return String.fromCharCode(...chunk.data.subarray(zero + 1));
    }
    return null;
}


export function dataUrlToBytes(dataUrl) {
    const match = /^data:[^,]*,([\s\S]*)$/.exec(dataUrl || '');
    if (!match) throw new Error('Not a data URL');
    const raw = atob(match[1]);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
}


export function downloadBytes(bytes, filename, type) {
    const blob = new Blob([bytes], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}
