import { prefs } from './preferences';

/**
 * State for the Photoshop-style tool palette.
 *
 * The palette is additive: `select` keeps iD's normal click-to-select
 * behaviour, the other tools install their own gestures while the editor stays
 * in browse mode (so they never fight the mode behaviors).
 */

export const BETTERID_TOOL_PREF = 'betterid.tools.active';
export const BETTERID_MARQUEE_SHAPE_PREF = 'betterid.tools.marquee_shape';
export const BETTERID_BRUSH_SIZE_PREF = 'betterid.tools.brush_size';
export const BETTERID_WAND_TOLERANCE_PREF = 'betterid.tools.wand_tolerance';
export const BETTERID_WAND_CONTIGUOUS_PREF = 'betterid.tools.wand_contiguous';
export const BETTERID_ADOBE_SHORTCUTS_PREF = 'betterid.editing.adobe_shortcuts';

export const BETTERID_TOOLS = ['select', 'marquee', 'quickselect', 'magicwand', 'pen'];
export const BETTERID_MARQUEE_SHAPES = ['rect', 'ellipse'];

const TOOL_DEFAULTS = {
    marquee: 'marquee',
    marqueeShape: 'rect',
    brushSize: 40,
    wandTolerance: 1,
    wandContiguous: true,
    adobeShortcuts: true
};


function clampedInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}


export function betteridTool() {
    const value = prefs(BETTERID_TOOL_PREF);
    return BETTERID_TOOLS.indexOf(value) === -1 ? 'select' : value;
}


export function setBetteridTool(tool) {
    prefs(BETTERID_TOOL_PREF, BETTERID_TOOLS.indexOf(tool) === -1 ? 'select' : tool);
}


export function marqueeShape() {
    const value = prefs(BETTERID_MARQUEE_SHAPE_PREF);
    return BETTERID_MARQUEE_SHAPES.indexOf(value) === -1 ? TOOL_DEFAULTS.marqueeShape : value;
}


export function setMarqueeShape(shape) {
    prefs(BETTERID_MARQUEE_SHAPE_PREF, BETTERID_MARQUEE_SHAPES.indexOf(shape) === -1 ? 'rect' : shape);
}


export function cycleMarqueeShape() {
    const index = BETTERID_MARQUEE_SHAPES.indexOf(marqueeShape());
    setMarqueeShape(BETTERID_MARQUEE_SHAPES[(index + 1) % BETTERID_MARQUEE_SHAPES.length]);
}


export function brushSize() {
    return clampedInt(prefs(BETTERID_BRUSH_SIZE_PREF), TOOL_DEFAULTS.brushSize, 8, 200);
}


export function setBrushSize(size) {
    prefs(BETTERID_BRUSH_SIZE_PREF, String(clampedInt(size, TOOL_DEFAULTS.brushSize, 8, 200)));
}


export function wandTolerance() {
    return clampedInt(prefs(BETTERID_WAND_TOLERANCE_PREF), TOOL_DEFAULTS.wandTolerance, 0, 10);
}


export function setWandTolerance(tolerance) {
    prefs(BETTERID_WAND_TOLERANCE_PREF, String(clampedInt(tolerance, TOOL_DEFAULTS.wandTolerance, 0, 10)));
}


export function wandContiguous() {
    const value = prefs(BETTERID_WAND_CONTIGUOUS_PREF);
    if (value === null || value === undefined) return TOOL_DEFAULTS.wandContiguous;
    return value === 'true';
}


export function setWandContiguous(value) {
    prefs(BETTERID_WAND_CONTIGUOUS_PREF, value ? 'true' : 'false');
}


export function adobeShortcutsEnabled() {
    const value = prefs(BETTERID_ADOBE_SHORTCUTS_PREF);
    if (value === null || value === undefined) return TOOL_DEFAULTS.adobeShortcuts;
    return value === 'true';
}


export function setAdobeShortcuts(value) {
    prefs(BETTERID_ADOBE_SHORTCUTS_PREF, value ? 'true' : 'false');
}


/**
 * Modifier semantics shared by every selection tool, matching Photoshop:
 * `Shift` adds, `Alt` subtracts, both intersect, none replaces.
 *
 * @param {KeyboardEvent|PointerEvent} d3_event
 * @returns {'replace'|'add'|'subtract'|'intersect'}
 */
export function selectionMode(d3_event) {
    const shift = Boolean(d3_event.shiftKey);
    const alt = Boolean(d3_event.altKey);
    if (shift && alt) return 'intersect';
    if (shift) return 'add';
    if (alt) return 'subtract';
    return 'replace';
}


/**
 * Combine a new set of feature ids with the current selection using the
 * Photoshop modifier semantics.
 *
 * @param {string[]} currentIDs
 * @param {string[]} newIDs
 * @param {'replace'|'add'|'subtract'|'intersect'} mode
 * @returns {string[]}
 */
export function combineSelection(currentIDs, newIDs, mode) {
    const current = new Set(currentIDs);
    const incoming = new Set(newIDs);

    if (mode === 'add') {
        const result = new Set(current);
        incoming.forEach(id => result.add(id));
        return Array.from(result);
    }
    if (mode === 'subtract') {
        incoming.forEach(id => current.delete(id));
        return Array.from(current);
    }
    if (mode === 'intersect') {
        return Array.from(current).filter(id => incoming.has(id));
    }
    return Array.from(incoming);
}
