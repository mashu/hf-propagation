// SPDX-FileCopyrightText: 2025 Mateusz Kaduk
// SPDX-License-Identifier: GPL-3.0-or-later

// Custom-drawn widgets. Colours are read from the stylesheet (custom
// "-hfp-*" properties) so light and dark styles stay in sync with the CSS.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import * as Solar from './solar.js';
import * as WorldMap from './worldmap.js';
import {BANDS} from './model.js';

/**
 * St.BoxLayout lost its "vertical" property in GNOME 49; "orientation"
 * only exists since GNOME 48.
 *
 * @param {boolean} vertical - stack children vertically
 * @param {object} params - other St.BoxLayout properties
 * @returns {St.BoxLayout}
 */
export function box(vertical, params = {}) {
    if (parseInt(Config.PACKAGE_VERSION) >= 48) {
        return new St.BoxLayout({
            ...params,
            orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
        });
    }
    return new St.BoxLayout({...params, vertical});
}

export const hbox = params => box(false, params);
export const vbox = params => box(true, params);

/**
 * @param {string} text - label text
 * @param {string} styleClass - CSS classes
 * @param {object} params - more St.Label properties; `ellipsize: true` for long dynamic text
 * @returns {St.Label}
 */
export function label(text, styleClass, params = {}) {
    const {ellipsize = false, ...rest} = params;
    const l = new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...rest});
    l.clutter_text.ellipsize = ellipsize ? Pango.EllipsizeMode.END : Pango.EllipsizeMode.NONE;
    return l;
}

const FALLBACK = {r: 0.5, g: 0.5, b: 0.5, a: 1};

function themeColor(node, name, fallback = FALLBACK) {
    const [ok, c] = node.lookup_color(name, true);
    if (!ok)
        return fallback;
    return {r: c.red / 255, g: c.green / 255, b: c.blue / 255, a: c.alpha / 255};
}

function setColor(cr, c, alphaScale = 1) {
    cr.setSourceRGBA(c.r, c.g, c.b, c.a * alphaScale);
}

function mix(a, b, t) {
    return {
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t,
        a: a.a + (b.a - a.a) * t,
    };
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

/**
 * Status colour ramp shared by all score visualisations.
 */
class Palette {
    constructor(node) {
        this.excellent = themeColor(node, '-hfp-excellent');
        this.good = themeColor(node, '-hfp-good');
        this.fair = themeColor(node, '-hfp-fair');
        this.poor = themeColor(node, '-hfp-poor');
        this.closed = themeColor(node, '-hfp-closed');
        this.track = themeColor(node, '-hfp-track', {r: 0.5, g: 0.5, b: 0.5, a: 0.15});
        this.accent = themeColor(node, '-hfp-accent');
        this.fg = themeColor(node, '-hfp-fg', {r: 1, g: 1, b: 1, a: 1});
    }

    /**
     * @param {number} score - 0..1
     * @returns {{r: number, g: number, b: number, a: number}}
     */
    forScore(score) {
        const stops = [
            [0.10, this.track],
            [0.18, this.poor],
            [0.36, this.fair],
            [0.55, this.good],
            [0.75, this.excellent],
        ];
        if (score <= stops[0][0])
            return stops[0][1];
        for (let i = 1; i < stops.length; i++) {
            if (score <= stops[i][0]) {
                const [s0, c0] = stops[i - 1];
                const [s1, c1] = stops[i];
                return mix(c0, c1, (score - s0) / (s1 - s0));
            }
        }
        return this.excellent;
    }
}

/**
 * Base class: a drawing area that repaints itself on style changes and
 * exposes the palette to subclasses.
 */
const Canvas = GObject.registerClass(
class Canvas extends St.DrawingArea {
    _init(params) {
        super._init(params);
        this._palette = null;
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        this._palette = null;
        this.queue_repaint();
    }

    get palette() {
        this._palette ??= new Palette(this.get_theme_node());
        return this._palette;
    }

    color(name, fallback) {
        return themeColor(this.get_theme_node(), name, fallback);
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        this.draw(cr, w, h);
        cr.$dispose();
    }

    draw() {}
});

/**
 * 270° ring gauge for the overall propagation index.
 */
export const RingGauge = GObject.registerClass(
class RingGauge extends Canvas {
    _init(params) {
        super._init({style_class: 'hfp-gauge', ...params});
        this._value = 0;
        this._condition = 'closed';
    }

    setValue(value, condition) {
        this._value = Math.max(0, Math.min(1, value ?? 0));
        this._condition = condition;
        this.queue_repaint();
    }

    draw(cr, w, h) {
        const p = this.palette;
        const lw = 7;
        const r = Math.min(w, h) / 2 - lw / 2 - 1;
        const cx = w / 2, cy = h / 2;
        const a0 = 0.75 * Math.PI;
        const a1 = 2.25 * Math.PI;

        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(lw);
        setColor(cr, p.track);
        cr.arc(cx, cy, r, a0, a1);
        cr.stroke();

        if (this._value > 0.005) {
            const end = a0 + (a1 - a0) * this._value;
            const steps = Math.max(2, Math.ceil(this._value * 48));
            // Gradient along the arc: draw short segments with interpolated colours.
            cr.setLineCap(Cairo.LineCap.BUTT);
            for (let i = 0; i < steps; i++) {
                const t0 = i / steps, t1 = (i + 1) / steps;
                setColor(cr, p.forScore(0.2 + 0.8 * (t1 * this._value)));
                cr.arc(cx, cy, r, a0 + (end - a0) * t0, a0 + (end - a0) * t1 + 0.01);
                cr.stroke();
            }

            // Rounded caps, with a soft glow on the tip.
            const c = p.forScore(0.2 + 0.8 * this._value);
            setColor(cr, p.forScore(0.2));
            cr.arc(cx + r * Math.cos(a0), cy + r * Math.sin(a0), lw / 2, 0, 2 * Math.PI);
            cr.fill();
            setColor(cr, c);
            cr.arc(cx + r * Math.cos(end), cy + r * Math.sin(end), lw / 2, 0, 2 * Math.PI);
            cr.fill();
            setColor(cr, c, 0.25);
            cr.arc(cx + r * Math.cos(end), cy + r * Math.sin(end), lw, 0, 2 * Math.PI);
            cr.fill();
        }
    }
});

/**
 * Bar chart of 3-hourly Kp: observed (solid) and forecast (faded).
 */
export const KpBars = GObject.registerClass(
class KpBars extends Canvas {
    _init(params) {
        super._init({style_class: 'hfp-kp-bars', ...params});
        this._observed = [];
        this._forecast = [];
    }

    setData(observed, forecast) {
        this._observed = observed ?? [];
        this._forecast = forecast ?? [];
        this.queue_repaint();
    }

    _colorFor(kp) {
        const p = this.palette;
        if (kp >= 7)
            return p.closed;
        if (kp >= 5)
            return p.poor;
        if (kp >= 4)
            return p.fair;
        return p.excellent;
    }

    draw(cr, w, h) {
        const bars = [...this._observed.map(kp => [kp, 1]), ...this._forecast.map(kp => [kp, 0.4])];
        if (bars.length === 0)
            return;
        const gap = 1.5;
        const bw = (w - gap * (bars.length - 1)) / bars.length;
        const top = Math.max(5, ...bars.map(([kp]) => kp));
        bars.forEach(([kp, alpha], i) => {
            const bh = Math.max(2, (Math.min(kp, top) / top) * h);
            setColor(cr, this._colorFor(kp), alpha);
            roundedRect(cr, i * (bw + gap), h - bh, bw, bh, Math.min(1.5, bw / 2));
            cr.fill();
        });
        if (this._forecast.length && this._observed.length) {
            // Divider between past and future.
            const x = this._observed.length * (bw + gap) - gap / 2;
            setColor(cr, this.palette.fg, 0.35);
            cr.rectangle(x - 0.5, 0, 1, h);
            cr.fill();
        }
    }
});

/**
 * X-ray flux sparkline on a logarithmic scale with C/M/X guides.
 */
export const XraySpark = GObject.registerClass(
class XraySpark extends Canvas {
    _init(params) {
        super._init({style_class: 'hfp-spark', ...params});
        this._series = [];
    }

    setSeries(series) {
        this._series = series ?? [];
        this.queue_repaint();
    }

    draw(cr, w, h) {
        const p = this.palette;
        const lo = -8, hi = -3.5;
        const yOf = flux => h - ((Math.log10(Math.max(flux, 1e-9)) - lo) / (hi - lo)) * h;

        // Guides at C, M and X levels.
        cr.setLineWidth(1);
        for (const [lvl, c] of [[-6, p.fair], [-5, p.poor], [-4, p.closed]]) {
            setColor(cr, c, 0.35);
            const y = Math.round(yOf(10 ** lvl)) + 0.5;
            cr.setDash([2, 2], 0);
            cr.moveTo(0, y);
            cr.lineTo(w, y);
            cr.stroke();
        }
        cr.setDash([], 0);

        const s = this._series;
        if (s.length < 2)
            return;
        const t0 = s[0].time, t1 = s[s.length - 1].time;
        const xOf = t => ((t - t0) / Math.max(1, t1 - t0)) * w;

        const last = s[s.length - 1].flux;
        let c = p.excellent;
        if (last >= 1e-4)
            c = p.closed;
        else if (last >= 1e-5)
            c = p.poor;
        else if (last >= 1e-6)
            c = p.fair;

        cr.moveTo(0, h);
        for (const pt of s)
            cr.lineTo(xOf(pt.time), yOf(pt.flux));
        cr.lineTo(w, h);
        cr.closePath();
        setColor(cr, c, 0.18);
        cr.fill();

        cr.setLineWidth(1.4);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        s.forEach((pt, i) => {
            if (i === 0)
                cr.moveTo(xOf(pt.time), yOf(pt.flux));
            else
                cr.lineTo(xOf(pt.time), yOf(pt.flux));
        });
        setColor(cr, c);
        cr.stroke();

        setColor(cr, c);
        cr.arc(xOf(t1), yOf(last), 2.2, 0, 2 * Math.PI);
        cr.fill();
    }
});

/**
 * Logarithmic 1.6–56 MHz spectrum with the usable window (LUF..MUF) and
 * amateur band markers.
 */
export const SpectrumBar = GObject.registerClass(
class SpectrumBar extends Canvas {
    _init(params) {
        super._init({style_class: 'hfp-spectrum', ...params});
        this._luf = null;
        this._muf = null;
        this._fof2 = null;
    }

    setWindow(luf, muf, fof2) {
        this._luf = luf;
        this._muf = muf;
        this._fof2 = fof2;
        this.queue_repaint();
    }

    draw(cr, w) {
        const p = this.palette;
        const fMin = 1.6, fMax = 56;
        const xOf = f => (Math.log(f / fMin) / Math.log(fMax / fMin)) * w;
        const barY = 2, barH = 8;

        setColor(cr, p.track);
        roundedRect(cr, 0, barY, w, barH, barH / 2);
        cr.fill();

        if (this._luf && this._muf && this._muf > this._luf) {
            const x0 = xOf(Math.max(fMin, this._luf));
            const x1 = xOf(Math.min(fMax, this._muf));
            // Usable window: fair at the edges, excellent in the sweet spot (FOT ≈ 0.85 MUF).
            cr.save();
            roundedRect(cr, x0, barY, Math.max(barH, x1 - x0), barH, barH / 2);
            cr.clip();
            const steps = 40;
            for (let i = 0; i < steps; i++) {
                const xa = x0 + ((x1 - x0) * i) / steps;
                const xb = x0 + ((x1 - x0) * (i + 1)) / steps;
                const t = (i + 0.5) / steps;
                const q = Math.min(1, t / 0.25, (1 - t) / 0.12);
                setColor(cr, p.forScore(0.36 + 0.42 * q));
                cr.rectangle(xa, barY, xb - xa + 0.3, barH);
                cr.fill();
            }
            cr.restore();
        }

        if (this._fof2) {
            const x = xOf(Math.min(fMax, Math.max(fMin, this._fof2)));
            setColor(cr, p.fg, 0.75);
            cr.rectangle(Math.round(x) - 0.5, barY - 2, 1, barH + 4);
            cr.fill();
        }

        // Band markers and labels.
        const layout = PangoCairo.create_layout(cr);
        const font = this.get_theme_node().get_font().copy();
        font.set_absolute_size(8.5 * Pango.SCALE);
        font.set_weight(Pango.Weight.NORMAL);
        layout.set_font_description(font);
        const labelled = ['160m', '80m', '40m', '20m', '15m', '10m', '6m'];
        for (const b of BANDS) {
            const x = xOf(b.freq);
            const inWindow = this._luf && this._muf && b.freq >= this._luf && b.freq <= this._muf;
            setColor(cr, p.fg, inWindow ? 0.9 : 0.35);
            cr.rectangle(Math.round(x) - 0.5, barY + barH + 2, 1, 3);
            cr.fill();
            if (!labelled.includes(b.id))
                continue;
            layout.set_text(b.id, -1);
            const [, logical] = layout.get_pixel_extents();
            let lx = x - logical.width / 2;
            lx = Math.max(0, Math.min(w - logical.width, lx));
            cr.moveTo(lx, barY + barH + 5);
            setColor(cr, p.fg, inWindow ? 0.85 : 0.4);
            PangoCairo.show_layout(cr, layout);
        }
    }
});

/**
 * Dot-matrix world map with day/night shading, grey line, the sub-solar
 * point, the station and the ionosondes used for calibration.
 */
export const WorldMapView = GObject.registerClass(
class WorldMapView extends Canvas {
    _init(params) {
        super._init({style_class: 'hfp-map', ...params});
        this._time = Date.now();
        this._qth = null;
        this._stations = [];
    }

    update(time, qth, stations) {
        this._time = time;
        this._qth = qth;
        this._stations = stations ?? [];
        this.queue_repaint();
    }

    draw(cr, w, h) {
        const latTop = WorldMap.LAT_TOP, latBottom = WorldMap.LAT_BOTTOM;
        const xOf = lon => ((lon + 180) / 360) * w;
        const yOf = lat => ((latTop - lat) / (latTop - latBottom)) * h;

        const bg = this.color('-hfp-map-bg', {r: 0, g: 0, b: 0, a: 0.15});
        const shade = this.color('-hfp-night-shade', {r: 0, g: 0, b: 0.1, a: 0.45});
        const landDay = this.color('-hfp-land-day');
        const landNight = this.color('-hfp-land-night');
        const landTwilight = this.color('-hfp-land-twilight');
        const terminator = this.color('-hfp-terminator');
        const sunColor = this.color('-hfp-sun');
        const qthColor = this.color('-hfp-qth');
        const stationColor = this.color('-hfp-station');

        const sun = Solar.sunPosition(this._time);
        const RAD = Math.PI / 180;
        const sinD = Math.sin(sun.declination * RAD), cosD = Math.cos(sun.declination * RAD);
        const elevOf = (lat, lon) => {
            const c = Math.sin(lat * RAD) * sinD + Math.cos(lat * RAD) * cosD * Math.cos((lon - sun.subLon) * RAD);
            return Math.asin(Math.max(-1, Math.min(1, c))) / RAD;
        };

        cr.save();
        roundedRect(cr, 0, 0, w, h, 10);
        cr.clip();

        setColor(cr, bg);
        cr.paint();

        // Night shading: smooth through civil, nautical and astronomical twilight.
        const cell = 2;
        for (let y = 0; y < h; y += cell) {
            const lat = latTop - ((y + cell / 2) / h) * (latTop - latBottom);
            for (let x = 0; x < w; x += cell) {
                const lon = ((x + cell / 2) / w) * 360 - 180;
                const e = elevOf(lat, lon);
                if (e > 2)
                    continue;
                const t = Math.min(1, (2 - e) / 16);
                setColor(cr, shade, t * t * (3 - 2 * t));
                cr.rectangle(x, y, cell, cell);
                cr.fill();
            }
        }

        const r = Math.max(0.9, (w / WorldMap.COLUMNS) * 0.36);
        WorldMap.forEachLandCell((lat, lon) => {
            const e = elevOf(lat, lon);
            let c;
            if (e > 8)
                c = landDay;
            else if (e > Solar.GREYLINE_HIGH)
                c = mix(landTwilight, landDay, (e - Solar.GREYLINE_HIGH) / (8 - Solar.GREYLINE_HIGH));
            else if (e >= Solar.GREYLINE_LOW)
                c = landTwilight;
            else if (e > -12)
                c = mix(landNight, landTwilight, (e + 12) / (Solar.GREYLINE_LOW + 12));
            else
                c = landNight;
            setColor(cr, c);
            cr.arc(xOf(lon), yOf(lat), r, 0, 2 * Math.PI);
            cr.fill();
        });

        // Terminator line with glow.
        const dec = Math.abs(sun.declination) < 0.05 ? 0.05 : sun.declination;
        const tanD = Math.tan(dec * RAD);
        const path = () => {
            for (let x = 0; x <= w; x += 2) {
                const lon = (x / w) * 360 - 180;
                const lat = Math.atan(-Math.cos((lon - sun.subLon) * RAD) / tanD) / RAD;
                if (x === 0)
                    cr.moveTo(x, yOf(lat));
                else
                    cr.lineTo(x, yOf(lat));
            }
        };
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        path();
        cr.setLineWidth(6);
        setColor(cr, terminator, 0.14);
        cr.stroke();
        path();
        cr.setLineWidth(1.3);
        setColor(cr, terminator, 0.85);
        cr.stroke();

        // Sub-solar point.
        const sx = xOf(sun.subLon), sy = yOf(sun.declination);
        for (const [rad, alpha] of [[14, 0.08], [9, 0.16], [5.5, 0.35]]) {
            setColor(cr, sunColor, alpha);
            cr.arc(sx, sy, rad, 0, 2 * Math.PI);
            cr.fill();
        }
        setColor(cr, sunColor);
        cr.arc(sx, sy, 3.2, 0, 2 * Math.PI);
        cr.fill();

        // Ionosondes used for calibration.
        for (const s of this._stations) {
            const x = xOf(s.lon), y = yOf(s.lat);
            setColor(cr, stationColor);
            cr.moveTo(x, y - 3);
            cr.lineTo(x + 3, y);
            cr.lineTo(x, y + 3);
            cr.lineTo(x - 3, y);
            cr.closePath();
            cr.fill();
        }

        // Station.
        if (this._qth) {
            const x = xOf(this._qth.lon), y = yOf(this._qth.lat);
            setColor(cr, qthColor, 0.18);
            cr.arc(x, y, 9, 0, 2 * Math.PI);
            cr.fill();
            cr.setLineWidth(1.5);
            setColor(cr, qthColor, 0.9);
            cr.arc(x, y, 5.5, 0, 2 * Math.PI);
            cr.stroke();
            setColor(cr, qthColor);
            cr.arc(x, y, 2.4, 0, 2 * Math.PI);
            cr.fill();
        }

        cr.restore();
    }
});

/**
 * Day / grey line / night strip for the outlook hours.
 */
export const DaylightStrip = GObject.registerClass(
class DaylightStrip extends Canvas {
    _init(params) {
        super._init({style_class: 'hfp-daylight', ...params});
        this._phases = [];
    }

    setPhases(phases) {
        this._phases = phases ?? [];
        this.queue_repaint();
    }

    draw(cr, w, h) {
        const n = this._phases.length;
        if (!n)
            return;
        const colors = {
            day: this.color('-hfp-day'),
            greyline: this.color('-hfp-twilight'),
            night: this.color('-hfp-night'),
        };
        const pitch = w / n;
        cr.save();
        roundedRect(cr, 0, 0, w, h, h / 2);
        cr.clip();
        this._phases.forEach((ph, i) => {
            setColor(cr, colors[ph] ?? colors.night);
            cr.rectangle(i * pitch, 0, pitch + 0.5, h);
            cr.fill();
        });
        cr.restore();
    }
});

/**
 * One band's 24-hour outlook as a row of rounded cells.
 */
export const HeatStrip = GObject.registerClass(
class HeatStrip extends Canvas {
    _init(params) {
        super._init({style_class: 'hfp-strip', ...params});
        this._scores = [];
        this._best = null;
        this._midnight = -1;
    }

    /**
     * @param {number[]} scores - hourly scores
     * @param {{from: number, to: number}|null} best - best window indices
     * @param {number} midnight - index of the first hour of the next day, -1 if none
     */
    setData(scores, best, midnight) {
        this._scores = scores ?? [];
        this._best = best;
        this._midnight = midnight;
        this.queue_repaint();
    }

    draw(cr, w, h) {
        const p = this.palette;
        const n = this._scores.length || 24;
        const gap = 2;
        const cw = (w - gap * (n - 1)) / n;
        const cellH = h - 5;

        for (let i = 0; i < n; i++) {
            const s = this._scores[i] ?? 0;
            setColor(cr, p.forScore(s));
            roundedRect(cr, i * (cw + gap), 0, cw, cellH, 2.5);
            cr.fill();
        }

        // Now: subtle outline on the first cell.
        cr.setLineWidth(1);
        setColor(cr, p.fg, 0.55);
        roundedRect(cr, 0.5, 0.5, cw - 1, cellH - 1, 2.5);
        cr.stroke();

        if (this._midnight > 0 && this._midnight < n) {
            const x = this._midnight * (cw + gap) - gap / 2;
            setColor(cr, p.fg, 0.25);
            cr.rectangle(x - 0.5, -1, 1, cellH + 2);
            cr.fill();
        }

        if (this._best) {
            const x0 = this._best.from * (cw + gap);
            const x1 = (this._best.to - 1) * (cw + gap) + cw;
            setColor(cr, p.accent);
            roundedRect(cr, x0, h - 2.5, x1 - x0, 2.5, 1.25);
            cr.fill();
        }
    }
});
