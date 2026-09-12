import { select as d3_select } from 'd3-selection';

import { actionCopyEntities } from '../actions/copy_entities';
import { actionDeleteMultiple } from '../actions/delete_multiple';
import { actionMove } from '../actions/move';
import { adobeShortcutsEnabled } from '../core/betterid_tools';
import { t } from '../core/localizer';
import { modeRotate } from '../modes/rotate';
import { modeSelect } from '../modes/select';
import { utilFastMouse } from '../util';


var DUPLICATE_OFFSET_PX = [12, 12];
var WHEEL_PAN_FACTOR = 1.0;
var WHEEL_ZOOM_FACTOR = 0.0025;
var SPACE_KEYS = ['Space', ' '];


/**
 * Adobe (Photoshop) style navigation and clipboard shortcuts.
 *
 * Everything here is opt-in through `betterid.editing.adobe_shortcuts` so the
 * stock iD feel stays available:
 *   - wheel = vertical pan, Ctrl+wheel = horizontal pan, Alt+wheel = zoom
 *   - hold Space = temporary hand tool
 *   - Alt+click = eyedropper (copies the hex colour under the pointer)
 *   - Ctrl+T free transform, Ctrl+J duplicate, Ctrl+Shift+V paste in place,
 *     Ctrl+Shift+T / Ctrl+Alt+Shift+T repeat the last transform
 */
export function behaviorBetteridAdobe(context) {
    var prefix = 'PointerEvent' in window ? 'pointer' : 'mouse';
    var _lastTransform = null;   // { delta: [dLon, dLat] }
    var _spaceDown = false;


    function enabled() {
        return adobeShortcutsEnabled();
    }


    function container() {
        return context.container();
    }


    function mapNode() {
        return container().select('.main-map').node();
    }


    function mouseLoc(d3_event) {
        var node = mapNode();
        if (!node) return [0, 0];
        return utilFastMouse(node)(d3_event);
    }


    function isTextEntry(d3_event) {
        var target = d3_event.target;
        if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return true;
        var active = document.activeElement;
        return Boolean(active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
    }


    function overMap(d3_event) {
        var target = d3_event.target;
        return Boolean(target && target.closest && target.closest('.main-map'));
    }


    /* ---------------------------------------------------------------- wheel */

    function wheel(d3_event) {
        if (!enabled() || isTextEntry(d3_event)) return;
        if (!overMap(d3_event)) return;

        var deltaY = d3_event.deltaY;
        if (d3_event.deltaMode === 1) deltaY *= 20;      // lines
        else if (d3_event.deltaMode === 2) deltaY *= 100; // pages

        d3_event.preventDefault();
        d3_event.stopPropagation();

        if (d3_event.altKey) {
            // wheel up (deltaY < 0) zooms in, like Photoshop
            zoomAtPointer(d3_event, Math.exp(-deltaY * WHEEL_ZOOM_FACTOR));

        } else if (d3_event.ctrlKey || d3_event.metaKey) {
            // Scrolling follows the document convention: scrolling down moves the
            // map content up (and sideways for the horizontal wheel).
            context.map().pan([-deltaY * WHEEL_PAN_FACTOR, 0]);

        } else {
            context.map().pan([0, -deltaY * WHEEL_PAN_FACTOR]);
        }
    }


    function zoomAtPointer(d3_event, factor) {
        var map = context.map();
        var point = mouseLoc(d3_event);
        var transform = context.projection.transform();

        var target = transform.scale(factor);
        var inverted = transform.invert(point);
        target.x = point[0] - inverted[0] * target.k;
        target.y = point[1] - inverted[1] * target.k;

        map.transformEase(target);
    }


    /* --------------------------------------------------------- space = hand */

    function keydown(d3_event) {
        if (!enabled() || isTextEntry(d3_event)) return;

        if (SPACE_KEYS.indexOf(d3_event.key) !== -1) {
            if (_spaceDown) return;
            _spaceDown = true;
            container().classed('betterid-hand-tool', true);
            d3_event.preventDefault();
            d3_event.stopPropagation();
            return;
        }

        var key = (d3_event.key || '').toLowerCase();

        if ((d3_event.ctrlKey || d3_event.metaKey) && !d3_event.shiftKey && key === 't') {
            freeTransform(d3_event);

        } else if ((d3_event.ctrlKey || d3_event.metaKey) && key === 'j') {
            if (d3_event.shiftKey) {
                cutToClipboard(d3_event);
            } else {
                duplicateSelection(d3_event);
            }

        } else if ((d3_event.ctrlKey || d3_event.metaKey) && d3_event.shiftKey && key === 'v') {
            pasteInPlace(d3_event);

        } else if ((d3_event.ctrlKey || d3_event.metaKey) && d3_event.shiftKey && key === 't') {
            repeatTransform(d3_event, d3_event.altKey);
        }
    }


    function keyup(d3_event) {
        if (SPACE_KEYS.indexOf(d3_event.key) === -1) return;
        _spaceDown = false;
        container().classed('betterid-hand-tool', false);
    }


    function blur() {
        _spaceDown = false;
        container().classed('betterid-hand-tool', false);
    }


    /* ------------------------------------------------------- eyedropper */

    function pointerdown(d3_event) {
        if (!enabled() || _spaceDown) return;
        if (!d3_event.altKey || d3_event.ctrlKey || d3_event.metaKey) return;
        if (!overMap(d3_event) || d3_event.button !== 0) return;

        var hex = sampleColor(d3_event.clientX, d3_event.clientY);
        if (!hex) return;

        d3_event.preventDefault();
        d3_event.stopPropagation();

        var label = () => t('betterid.tools.eyedropper_copied', { color: hex });
        context.ui().flash
            .duration(3000)
            .iconName('#fas-eye-dropper')
            .iconClass('operation')
            .label(label)();

        copyText(hex);
    }


    function sampleColor(clientX, clientY) {
        var elements = document.elementsFromPoint
            ? document.elementsFromPoint(clientX, clientY)
            : [document.elementFromPoint(clientX, clientY)];

        for (var i = 0; i < elements.length; i++) {
            var element = elements[i];
            if (!element) continue;

            var hex = null;
            if (element.tagName === 'IMG') {
                hex = sampleImage(element, clientX, clientY);
            } else if (element.tagName === 'CANVAS') {
                hex = sampleCanvas(element, clientX, clientY);
            }
            if (hex) return hex;
        }
        return null;
    }


    function sampleImage(image, clientX, clientY) {
        try {
            var rect = image.getBoundingClientRect();
            if (!rect.width || !rect.height) return null;

            var x = Math.floor((clientX - rect.left) * (image.naturalWidth / rect.width));
            var y = Math.floor((clientY - rect.top) * (image.naturalHeight / rect.height));
            if (x < 0 || y < 0 || x >= image.naturalWidth || y >= image.naturalHeight) return null;

            var canvas = document.createElement('canvas');
            canvas.width = 1;
            canvas.height = 1;
            var ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(image, x, y, 1, 1, 0, 0, 1, 1);
            return toHex(ctx.getImageData(0, 0, 1, 1).data);
        } catch {
            return null;   // cross-origin or unreadable
        }
    }


    function sampleCanvas(canvas, clientX, clientY) {
        try {
            var rect = canvas.getBoundingClientRect();
            if (!rect.width || !rect.height) return null;

            var x = Math.floor((clientX - rect.left) * (canvas.width / rect.width));
            var y = Math.floor((clientY - rect.top) * (canvas.height / rect.height));
            var ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) return null;
            return toHex(ctx.getImageData(x, y, 1, 1).data);
        } catch {
            return null;
        }
    }


    function toHex(data) {
        var value = (data[0] << 16) | (data[1] << 8) | data[2];
        return '#' + value.toString(16).padStart(6, '0').toUpperCase();
    }


    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(function() { /* ignore */ });
            return;
        }
        try {
            var input = document.createElement('textarea');
            input.value = text;
            input.setAttribute('readonly', 'readonly');
            input.style.position = 'fixed';
            input.style.opacity = '0';
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
        } catch { /* ignore */ }
    }


    /* ------------------------------------------------ transform & clipboard */

    function selectedIDs() {
        return context.selectedIDs().filter(id => context.hasEntity(id));
    }


    function screenDeltaToGeo(deltaPx) {
        var origin = context.map().center();
        var screen = context.projection(origin);
        var moved = context.projection.invert([screen[0] + deltaPx[0], screen[1] + deltaPx[1]]);
        return [moved[0] - origin[0], moved[1] - origin[1]];
    }


    function freeTransform(d3_event) {
        var ids = selectedIDs();
        if (!ids.length) return;
        d3_event.preventDefault();
        d3_event.stopPropagation();
        context.enter(modeRotate(context, ids));
    }


    function duplicateElements(ids, delta) {
        if (!ids.length) return [];

        var baseGraph = context.graph();
        var action = actionCopyEntities(ids, baseGraph);
        context.perform(action);

        var copies = action.copies();
        var newIDs = Object.keys(copies);
        if (!newIDs.length) return [];

        context.perform(actionMove(newIDs, delta, context.projection));
        return newIDs;
    }


    function duplicateSelection(d3_event) {
        var ids = selectedIDs();
        if (!ids.length) return;

        d3_event.preventDefault();
        d3_event.stopPropagation();

        var delta = screenDeltaToGeo(DUPLICATE_OFFSET_PX);
        var newIDs = duplicateElements(ids, delta);
        if (!newIDs.length) return;

        _lastTransform = { delta: delta };
        context.enter(modeSelect(context, newIDs));
    }


    function cutToClipboard(d3_event) {
        var ids = selectedIDs();
        if (!ids.length) return;

        d3_event.preventDefault();
        d3_event.stopPropagation();

        var delta = screenDeltaToGeo(DUPLICATE_OFFSET_PX);
        var newIDs = duplicateElements(ids, delta);
        if (!newIDs.length) return;

        context.perform(actionDeleteMultiple(ids));
        _lastTransform = { delta: delta };
        context.enter(modeSelect(context, newIDs));
    }


    function pasteInPlace(d3_event) {
        var oldIDs = context.copyIDs();
        if (!oldIDs || !oldIDs.length) {
            context.ui().flash
                .duration(4000)
                .iconName('#iD-icon-no')
                .iconClass('disabled')
                .label(t.append('operations.paste.nothing_copied'))();
            return;
        }

        d3_event.preventDefault();
        d3_event.stopPropagation();

        var newIDs = duplicateElements(oldIDs, [0, 0]);
        if (!newIDs.length) return;

        context.enter(modeSelect(context, newIDs));
    }


    function repeatTransform(d3_event, withCopy) {
        if (!_lastTransform) return;

        var ids = selectedIDs();
        if (!ids.length) return;

        d3_event.preventDefault();
        d3_event.stopPropagation();

        if (withCopy) {
            var newIDs = duplicateElements(ids, _lastTransform.delta);
            if (newIDs.length) context.enter(modeSelect(context, newIDs));
            return;
        }

        context.perform(actionMove(ids, _lastTransform.delta, context.projection));
    }


    function behavior() {
        d3_select(window)
            .on('wheel.betteridAdobe', wheel, { capture: true, passive: false })
            .on('keydown.betteridAdobe', keydown, true)
            .on('keyup.betteridAdobe', keyup, true)
            .on(prefix + 'down.betteridAdobe', pointerdown, true)
            .on('blur.betteridAdobe', blur);
    }


    behavior.off = function() {
        d3_select(window)
            .on('wheel.betteridAdobe', null, { capture: true })
            .on('keydown.betteridAdobe', null, true)
            .on('keyup.betteridAdobe', null, true)
            .on(prefix + 'down.betteridAdobe', null, true)
            .on('blur.betteridAdobe', null);
        blur();
    };


    return behavior;
}
