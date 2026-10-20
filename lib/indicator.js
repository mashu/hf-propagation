// Panel indicator and the propagation dashboard shown in its menu.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import * as Data from './data.js';
import * as Geo from './geo.js';
import * as Model from './model.js';
import * as Solar from './solar.js';
import * as W from './widgets.js';

const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;
const CACHE_MAX_AGE = 6 * HOUR;
const LIVE_MAP_URL = 'https://prop.kc2g.com/';

const CONDITIONS = ['excellent', 'good', 'fair', 'poor', 'closed'];

const HEADLINES = {
    excellent: 'Excellent HF conditions',
    good: 'Good HF conditions',
    fair: 'Fair HF conditions',
    poor: 'Poor HF conditions',
    closed: 'HF mostly closed',
};

const VHF_NAMES = {
    'vhf-aurora/northern_hemi': 'Aurora',
    'E-Skip/europe': 'Es EU 2m',
    'E-Skip/europe_4m': 'Es EU 4m',
    'E-Skip/europe_6m': 'Es EU 6m',
    'E-Skip/north_america': 'Es NA 2m',
};

const REFERENCE_GROUPS = ['80m-40m', '30m-20m', '17m-15m', '12m-10m'];

function setCondition(actor, condition, prefix = 'hfp-') {
    for (const c of CONDITIONS)
        actor.remove_style_class_name(`${prefix}${c}`);
    if (condition)
        actor.add_style_class_name(`${prefix}${condition}`);
}

function fmtNumber(v, digits = 0) {
    return v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(digits);
}

function fmtDuration(ms) {
    const total = Math.max(0, Math.round(ms / MINUTE));
    const h = Math.floor(total / 60), m = total % 60;
    return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

function kpCondition(kp) {
    if (kp === null || kp === undefined)
        return null;
    if (kp >= 7)
        return 'closed';
    if (kp >= 5)
        return 'poor';
    if (kp >= 4)
        return 'fair';
    if (kp >= 3)
        return 'good';
    return 'excellent';
}

function kpText(kp) {
    if (kp >= 7)
        return 'Severe storm';
    if (kp >= 5)
        return 'Storm';
    if (kp >= 4)
        return 'Active';
    if (kp >= 3)
        return 'Unsettled';
    return 'Quiet';
}

export const HFIndicator = GObject.registerClass(
class HFIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'HF Propagation', false);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._fetcher = new Data.Fetcher();
        this._raw = {};
        this._status = {};
        this._lastFetch = null;
        this._forecast = null;
        this._sun = null;
        this._location = null;
        this._destroyed = false;
        this._refreshing = false;

        this._icon = Gio.icon_new_for_string(
            GLib.build_filenamev([extension.path, 'icons', 'hf-propagation-symbolic.svg']));

        this._buildPanel();
        this._buildMenu();

        this._settingsIds = [
            this._settings.connect('changed', (s, key) => this._onSettingChanged(key)),
        ];
        this.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this._recompute();
        });

        // Refresh as soon as the network comes back after an outage or resume.
        this._networkMonitor = Gio.NetworkMonitor.get_default();
        this._networkChangedId = this._networkMonitor.connect('network-changed', (monitor, available) => {
            if (available && (!this._lastFetch || Date.now() - this._lastFetch > 5 * MINUTE))
                this._scheduleRetry(5);
        });

        this._startTimers();
        this._start().catch(e => console.error(`[HF Propagation] start: ${e}`));
    }

    async _start() {
        await this._resolveLocation();
        await this._loadCache();
        if (this._destroyed)
            return;
        this._recompute();
        await this._refresh();
    }

    // ── Panel ────────────────────────────────────────────────────────────

    _buildPanel() {
        const panelBox = W.hbox({style_class: 'hfp-panel-box', y_align: Clutter.ActorAlign.CENTER});

        panelBox.add_child(new St.Icon({
            gicon: this._icon,
            style_class: 'system-status-icon hfp-panel-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this._panelDot = new St.Widget({style_class: 'hfp-panel-dot', y_align: Clutter.ActorAlign.CENTER});
        panelBox.add_child(this._panelDot);

        const item = (key) => {
            const b = W.hbox({style_class: 'hfp-panel-item', y_align: Clutter.ActorAlign.CENTER});
            const k = W.label(key, 'hfp-panel-key', {opacity: 175});
            const v = W.label('–', 'hfp-panel-value');
            if (key)
                b.add_child(k);
            b.add_child(v);
            panelBox.add_child(b);
            return {box: b, value: v};
        };
        this._panelItems = {
            sfi: item('SFI'),
            kp: item('K'),
            muf: item('MUF'),
            best: item(''),
        };

        this.add_child(panelBox);
        this._updatePanelVisibility();
    }

    _updatePanelVisibility() {
        const s = this._settings;
        this._panelDot.visible = s.get_boolean('panel-show-status-dot');
        this._panelItems.sfi.box.visible = s.get_boolean('panel-show-sfi');
        this._panelItems.kp.box.visible = s.get_boolean('panel-show-kp');
        this._panelItems.muf.box.visible = s.get_boolean('panel-show-muf');
        this._panelItems.best.box.visible = s.get_boolean('panel-show-best-band');
    }

    // ── Menu ─────────────────────────────────────────────────────────────

    _buildMenu() {
        this.menu.actor.add_style_class_name('hfp-menu');
        this.menu.box.add_style_class_name('hfp-menu-box');

        const dash = W.vbox({style_class: 'hfp-dashboard'});
        dash.add_child(this._buildHeader());
        dash.add_child(this._buildHero());

        const columns = W.hbox({style_class: 'hfp-columns'});
        const left = W.vbox({style_class: 'hfp-column-left'});
        left.add_child(this._buildIonosphereCard());
        left.add_child(this._buildSunCard());
        const right = W.vbox({style_class: 'hfp-column-right', x_expand: true});
        right.add_child(this._buildOutlookCard());
        right.add_child(this._buildReferenceCard());
        columns.add_child(left);
        columns.add_child(right);
        dash.add_child(columns);

        dash.add_child(this._buildFooter());

        const scroll = new St.ScrollView({
            style_class: 'hfp-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        scroll.set_child(dash);
        this.menu.box.add_child(scroll);
    }

    _iconButton(iconName, accessibleName, callback) {
        const button = new St.Button({
            style_class: 'hfp-icon-button',
            can_focus: true,
            reactive: true,
            track_hover: true,
            accessible_name: accessibleName,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: iconName, style_class: 'hfp-icon-button-icon'}),
        });
        button.connect('clicked', callback);
        return button;
    }

    _card(title, extraClass = '') {
        const card = W.vbox({style_class: `hfp-card ${extraClass}`.trim()});
        const head = W.hbox({style_class: 'hfp-card-head'});
        head.add_child(W.label(title.toUpperCase(), 'hfp-card-title', {x_expand: true}));
        const aside = W.label('', 'hfp-card-aside', {ellipsize: true});
        head.add_child(aside);
        card.add_child(head);
        return {card, aside};
    }

    _buildHeader() {
        const header = W.hbox({style_class: 'hfp-header'});

        const logo = new St.Bin({
            style_class: 'hfp-logo',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({gicon: this._icon, style_class: 'hfp-logo-icon'}),
        });
        header.add_child(logo);

        const titles = W.vbox({style_class: 'hfp-titles', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        titles.add_child(W.label('HF Propagation', 'hfp-title'));
        this._subtitle = W.label('Locating station…', 'hfp-subtitle', {ellipsize: true});
        titles.add_child(this._subtitle);
        header.add_child(titles);

        const badges = W.hbox({style_class: 'hfp-badges', y_align: Clutter.ActorAlign.CENTER});
        this._scaleBadges = {};
        for (const k of ['R', 'S', 'G']) {
            const b = W.label(`${k}–`, 'hfp-badge');
            badges.add_child(b);
            this._scaleBadges[k] = b;
        }
        header.add_child(badges);

        this._refreshButton = this._iconButton('view-refresh-symbolic', 'Refresh now', () => {
            this._refresh().catch(e => console.error(`[HF Propagation] refresh: ${e}`));
        });
        header.add_child(this._refreshButton);
        header.add_child(this._iconButton('emblem-system-symbolic', 'Settings', () => {
            this.menu.close();
            this._extension.openPreferences();
        }));
        return header;
    }

    _buildHero() {
        const hero = W.hbox({style_class: 'hfp-hero'});

        // Summary with the overall index gauge.
        const summary = W.hbox({style_class: 'hfp-card hfp-summary'});
        const gaugeBox = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'hfp-gauge-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._gauge = new W.RingGauge();
        gaugeBox.add_child(this._gauge);
        const gaugeText = W.vbox({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._gaugeValue = W.label('–', 'hfp-gauge-value', {x_align: Clutter.ActorAlign.CENTER});
        this._gaugeCaption = W.label('HF INDEX', 'hfp-gauge-caption', {x_align: Clutter.ActorAlign.CENTER});
        gaugeText.add_child(this._gaugeValue);
        gaugeText.add_child(this._gaugeCaption);
        gaugeBox.add_child(gaugeText);
        summary.add_child(gaugeBox);

        const text = W.vbox({style_class: 'hfp-summary-text', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._headline = W.label('Waiting for data…', 'hfp-headline', {ellipsize: true});
        this._summaryDetail = W.label('Fetching solar and ionospheric data', 'hfp-summary-detail');
        this._summaryDetail.clutter_text.line_wrap = true;
        text.add_child(this._headline);
        text.add_child(this._summaryDetail);
        const bestRow = W.hbox({style_class: 'hfp-best-row'});
        this._bestRow = bestRow;
        bestRow.add_child(W.label('BEST', 'hfp-best-key'));
        this._bestNowBox = W.hbox({style_class: 'hfp-chips'});
        bestRow.add_child(this._bestNowBox);
        text.add_child(bestRow);
        summary.add_child(text);
        hero.add_child(summary);

        // Solar & geomagnetic tiles.
        const grid = W.vbox({style_class: 'hfp-tiles', x_expand: true});
        const row1 = W.hbox({style_class: 'hfp-tile-row'});
        const row2 = W.hbox({style_class: 'hfp-tile-row'});
        grid.add_child(row1);
        grid.add_child(row2);

        this._kpBars = new W.KpBars();
        this._xraySpark = new W.XraySpark();

        this._tiles = {
            sfi: this._tile(row1, 'Solar flux', 'sfu'),
            ssn: this._tile(row1, 'Sunspots', ''),
            kp: this._tile(row1, 'Kp index', '', this._kpBars),
            a: this._tile(row1, 'A index', ''),
            xray: this._tile(row2, 'X-ray', '', this._xraySpark),
            wind: this._tile(row2, 'Solar wind', 'km/s'),
            bz: this._tile(row2, 'Bz', 'nT'),
            protons: this._tile(row2, 'Protons', 'pfu'),
        };
        hero.add_child(grid);
        return hero;
    }

    _tile(row, key, unit, graphic = null) {
        const tile = W.vbox({style_class: 'hfp-tile', x_expand: true});
        const top = W.hbox();
        top.add_child(W.label(key.toUpperCase(), 'hfp-tile-key', {x_expand: true}));
        const aside = W.label('', 'hfp-tile-aside');
        top.add_child(aside);
        tile.add_child(top);

        const valueRow = W.hbox({style_class: 'hfp-tile-value-row'});
        const value = W.label('–', 'hfp-tile-value');
        valueRow.add_child(value);
        const unitLabel = W.label(unit, 'hfp-tile-unit', {y_align: Clutter.ActorAlign.END});
        valueRow.add_child(unitLabel);
        tile.add_child(valueRow);

        const caption = W.label('', 'hfp-tile-caption', {ellipsize: true});
        tile.add_child(graphic ?? caption);
        row.add_child(tile);
        return {tile, value, unit: unitLabel, caption, aside};
    }

    _metric(parent, key, unit) {
        const m = W.vbox({style_class: 'hfp-metric', x_expand: true});
        m.add_child(W.label(key.toUpperCase(), 'hfp-metric-key'));
        const row = W.hbox({style_class: 'hfp-metric-value-row'});
        const value = W.label('–', 'hfp-metric-value');
        row.add_child(value);
        const unitLabel = W.label(unit, 'hfp-metric-unit', {y_align: Clutter.ActorAlign.END});
        row.add_child(unitLabel);
        m.add_child(row);
        const caption = W.label('', 'hfp-metric-caption', {ellipsize: true});
        m.add_child(caption);
        parent.add_child(m);
        return {value, unit: unitLabel, caption};
    }

    _buildIonosphereCard() {
        const {card, aside} = this._card('Ionosphere', 'hfp-iono');
        this._ionoAside = aside;

        const row1 = W.hbox({style_class: 'hfp-metric-row'});
        const row2 = W.hbox({style_class: 'hfp-metric-row'});
        this._metrics = {
            muf: this._metric(row1, 'Local MUF', 'MHz'),
            fof2: this._metric(row1, 'foF2', 'MHz'),
            absorption: this._metric(row2, 'Absorption', ''),
            noise: this._metric(row2, 'Noise floor', ''),
        };
        card.add_child(row1);
        card.add_child(row2);

        const spectrumHead = W.hbox({style_class: 'hfp-spectrum-head'});
        spectrumHead.add_child(W.label('USABLE WINDOW', 'hfp-metric-key', {x_expand: true}));
        this._spectrumCaption = W.label('', 'hfp-spectrum-caption');
        spectrumHead.add_child(this._spectrumCaption);
        card.add_child(spectrumHead);
        this._spectrum = new W.SpectrumBar();
        card.add_child(this._spectrum);
        return card;
    }

    _buildSunCard() {
        const {card, aside} = this._card('Sun & grey line', 'hfp-sun');
        this._sunAside = aside;
        this._map = new W.WorldMapView();
        card.add_child(this._map);

        const grid = W.vbox({style_class: 'hfp-kv-grid'});
        const r1 = W.hbox({style_class: 'hfp-kv-row'});
        const r2 = W.hbox({style_class: 'hfp-kv-row'});
        grid.add_child(r1);
        grid.add_child(r2);
        const kv = (row, key) => {
            const b = W.vbox({style_class: 'hfp-kv', x_expand: true});
            b.add_child(W.label(key.toUpperCase(), 'hfp-kv-key'));
            const v = W.label('–', 'hfp-kv-value');
            const c = W.label('', 'hfp-kv-caption', {ellipsize: true});
            b.add_child(v);
            b.add_child(c);
            row.add_child(b);
            return {value: v, caption: c};
        };
        this._sunKv = {
            sunrise: kv(r1, 'Sunrise'),
            sunset: kv(r1, 'Sunset'),
            sun: kv(r2, 'Sun'),
            greyline: kv(r2, 'Grey line'),
        };
        card.add_child(grid);
        return card;
    }

    _buildOutlookCard() {
        const {card, aside} = this._card('Band outlook', 'hfp-outlook');
        this._outlookAside = aside;

        const head = W.hbox({style_class: 'hfp-band-row hfp-band-head'});
        head.add_child(W.label('BAND', 'hfp-col-band hfp-col-key'));
        head.add_child(W.label('NOW', 'hfp-col-now hfp-col-key'));
        this._hourLabels = [];
        const hours = W.hbox({style_class: 'hfp-col-strip hfp-hours'});
        for (let i = 0; i < 8; i++) {
            const l = W.label('', 'hfp-hour-label');
            hours.add_child(l);
            this._hourLabels.push(l);
        }
        head.add_child(hours);
        head.add_child(W.label('BEST', 'hfp-col-best hfp-col-key'));
        head.add_child(W.label('NOISE', 'hfp-col-noise hfp-col-key'));
        card.add_child(head);

        const dayRow = W.hbox({style_class: 'hfp-band-row hfp-daylight-row'});
        dayRow.add_child(new St.Widget({style_class: 'hfp-col-band'}));
        dayRow.add_child(new St.Widget({style_class: 'hfp-col-now'}));
        this._daylight = new W.DaylightStrip();
        dayRow.add_child(this._daylight);
        card.add_child(dayRow);

        this._bandRows = {};
        const rows = W.vbox({style_class: 'hfp-band-rows'});
        for (const band of Model.BANDS) {
            const row = W.hbox({style_class: 'hfp-band-row'});
            const name = W.hbox({style_class: 'hfp-col-band'});
            name.add_child(W.label(band.id, 'hfp-band-name'));
            row.add_child(name);

            const pillBin = new St.Bin({style_class: 'hfp-col-now', x_align: Clutter.ActorAlign.START});
            const pill = W.label('–', 'hfp-pill');
            pillBin.set_child(pill);
            row.add_child(pillBin);

            const strip = new W.HeatStrip();
            row.add_child(strip);

            const best = W.label('–', 'hfp-col-best hfp-best');
            row.add_child(best);
            const noise = W.label('–', 'hfp-col-noise hfp-noise');
            row.add_child(noise);

            rows.add_child(row);
            this._bandRows[band.id] = {pill, strip, best, noise};
        }
        card.add_child(rows);

        const legend = W.hbox({style_class: 'hfp-legend'});
        for (const c of ['excellent', 'good', 'fair', 'poor', 'closed']) {
            const item = W.hbox({style_class: 'hfp-legend-item'});
            item.add_child(new St.Widget({style_class: `hfp-legend-swatch hfp-swatch-${c}`, y_align: Clutter.ActorAlign.CENTER}));
            item.add_child(W.label(Model.CONDITION_LABELS[c], 'hfp-legend-label'));
            legend.add_child(item);
        }
        legend.add_child(new St.Widget({x_expand: true}));
        const bestKey = W.hbox({style_class: 'hfp-legend-item'});
        bestKey.add_child(new St.Widget({style_class: 'hfp-legend-best', y_align: Clutter.ActorAlign.CENTER}));
        bestKey.add_child(W.label('Best window', 'hfp-legend-label'));
        legend.add_child(bestKey);
        card.add_child(legend);
        return card;
    }

    _buildReferenceCard() {
        const {card, aside} = this._card('N0NBH band groups', 'hfp-reference');
        this._refAside = aside;

        const head = W.hbox({style_class: 'hfp-ref-row'});
        head.add_child(W.label('', 'hfp-ref-key'));
        for (const g of REFERENCE_GROUPS)
            head.add_child(W.label(g.replace(/m/g, '').replace('-', '–') + ' m', 'hfp-ref-col hfp-col-key'));
        card.add_child(head);

        this._refPills = {};
        for (const time of ['day', 'night']) {
            const row = W.hbox({style_class: 'hfp-ref-row'});
            row.add_child(W.label(time === 'day' ? 'Day' : 'Night', 'hfp-ref-key'));
            for (const g of REFERENCE_GROUPS) {
                const bin = new St.Bin({style_class: 'hfp-ref-col', x_align: Clutter.ActorAlign.START});
                const pill = W.label('–', 'hfp-pill');
                bin.set_child(pill);
                row.add_child(bin);
                this._refPills[`${g}/${time}`] = pill;
            }
            card.add_child(row);
        }

        this._vhfBox = W.hbox({style_class: 'hfp-vhf'});
        card.add_child(this._vhfBox);
        return card;
    }

    _buildFooter() {
        const footer = W.hbox({style_class: 'hfp-footer'});
        this._sourceDots = {};
        for (const [key, name] of [['hamqsl', 'HamQSL'], ['noaa', 'NOAA SWPC'], ['kc2g', 'KC2G']]) {
            const item = W.hbox({style_class: 'hfp-source', y_align: Clutter.ActorAlign.CENTER});
            const dot = new St.Widget({style_class: 'hfp-source-dot', y_align: Clutter.ActorAlign.CENTER});
            item.add_child(dot);
            item.add_child(W.label(name, 'hfp-source-label'));
            footer.add_child(item);
            this._sourceDots[key] = {item, dot};
        }
        footer.add_child(new St.Widget({x_expand: true}));
        this._updatedLabel = W.label('', 'hfp-updated', {ellipsize: true});
        footer.add_child(this._updatedLabel);

        const link = new St.Button({
            style_class: 'hfp-link',
            can_focus: true,
            label: 'Live MUF map ↗',
            y_align: Clutter.ActorAlign.CENTER,
        });
        link.connect('clicked', () => {
            this.menu.close();
            try {
                Gio.AppInfo.launch_default_for_uri(LIVE_MAP_URL, global.create_app_launch_context(0, -1));
            } catch (e) {
                console.error(`[HF Propagation] open map: ${e}`);
            }
        });
        footer.add_child(link);
        return footer;
    }

    // ── Settings, location and timers ────────────────────────────────────

    _onSettingChanged(key) {
        switch (key) {
        case 'location-source':
        case 'locator':
        case 'latitude':
        case 'longitude':
            this._resolveLocation().then(() => this._recompute())
                .catch(e => console.error(`[HF Propagation] location: ${e}`));
            break;
        case 'refresh-interval':
            this._startTimers();
            break;
        case 'use-ionosondes':
            this._refresh().catch(e => console.error(`[HF Propagation] refresh: ${e}`));
            break;
        case 'noise-environment':
        case 'use-utc':
            this._recompute();
            break;
        default:
            if (key.startsWith('panel-show-')) {
                this._updatePanelVisibility();
                this._renderPanel();
            }
        }
    }

    async _resolveLocation() {
        const s = this._settings;
        const source = s.get_string('location-source');
        let loc = null;

        if (source === 'locator') {
            const text = s.get_string('locator').trim();
            const p = Geo.locatorToLatLon(text);
            if (p) {
                const locator = text.slice(0, 2).toUpperCase() + text.slice(2, 4) +
                    text.slice(4, 6).toLowerCase() + text.slice(6);
                loc = {...p, locator, label: null, approximate: false};
            }
        } else if (source === 'coordinates') {
            loc = {lat: s.get_double('latitude'), lon: s.get_double('longitude'), label: null, approximate: false};
        }

        if (!loc) {
            const tz = await Geo.locationFromTimeZone();
            loc = {...tz, approximate: true};
        }
        loc.locator ??= Geo.latLonToLocator(loc.lat, loc.lon, 6);
        this._location = loc;
    }

    _startTimers() {
        this._stopTimers();
        const minutes = Math.max(5, this._settings.get_int('refresh-interval'));
        this._refreshTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, () => {
            this._refresh().catch(e => console.error(`[HF Propagation] refresh: ${e}`));
            return GLib.SOURCE_CONTINUE;
        });
        this._tickTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._recompute();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _scheduleRetry(seconds) {
        if (this._retryTimer)
            GLib.source_remove(this._retryTimer);
        this._retryTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._retryTimer = 0;
            this._refresh().catch(e => console.error(`[HF Propagation] refresh: ${e}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopTimers() {
        if (this._retryTimer) {
            GLib.source_remove(this._retryTimer);
            this._retryTimer = 0;
        }
        if (this._refreshTimer) {
            GLib.source_remove(this._refreshTimer);
            this._refreshTimer = 0;
        }
        if (this._tickTimer) {
            GLib.source_remove(this._tickTimer);
            this._tickTimer = 0;
        }
    }

    // ── Data ─────────────────────────────────────────────────────────────

    async _refresh() {
        if (this._refreshing || this._destroyed)
            return;
        this._refreshing = true;
        this._refreshButton.add_style_pseudo_class('busy');
        try {
            const result = await Data.fetchAll(this._fetcher, {
                ionosondes: this._settings.get_boolean('use-ionosondes'),
            });
            if (this._destroyed)
                return;
            for (const [k, st] of Object.entries(result.status)) {
                if (st.ok)
                    this._raw[k] = result.data[k];
                else
                    console.warn(`[HF Propagation] ${k}: ${st.error}`);
            }
            if (!this._settings.get_boolean('use-ionosondes'))
                delete this._raw.ionosondes;
            this._status = result.status;
            if (Object.values(result.status).some(st => st.ok)) {
                this._lastFetch = result.time;
                this._retryDelay = 0;
                this._saveCache();
            } else {
                // Nothing reachable (e.g. network not up yet): retry with back-off.
                this._retryDelay = Math.min(15 * 60, Math.max(60, (this._retryDelay ?? 0) * 2));
                this._scheduleRetry(this._retryDelay);
            }
        } finally {
            this._refreshing = false;
            if (!this._destroyed)
                this._refreshButton.remove_style_pseudo_class('busy');
        }
        if (!this._destroyed)
            this._recompute();
    }

    _cacheFile() {
        return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_cache_dir(), 'hf-propagation', 'last.json']));
    }

    _saveCache() {
        try {
            const file = this._cacheFile();
            GLib.mkdir_with_parents(file.get_parent().get_path(), 0o755);
            const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify({time: this._lastFetch, raw: this._raw})));
            file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null,
                (f, res) => {
                    try {
                        f.replace_contents_finish(res);
                    } catch (e) {
                        console.warn(`[HF Propagation] cache write: ${e.message}`);
                    }
                });
        } catch (e) {
            console.warn(`[HF Propagation] cache: ${e.message}`);
        }
    }

    _loadCache() {
        return new Promise(resolve => {
            this._cacheFile().load_contents_async(null, (f, res) => {
                try {
                    const [, contents] = f.load_contents_finish(res);
                    const cached = JSON.parse(new TextDecoder().decode(contents));
                    if (cached?.raw && Date.now() - cached.time < CACHE_MAX_AGE && !this._lastFetch) {
                        this._raw = cached.raw;
                        this._lastFetch = cached.time;
                        this._status = {cached: {ok: true}};
                    }
                } catch {
                    // No cache yet.
                }
                resolve();
            });
        });
    }

    _inputs() {
        const raw = this._raw;
        const ham = raw.hamqsl ?? null;
        const kpNow = raw.kpNow?.kp ?? ham?.kIndex ?? null;
        const xrayFlux = raw.xray?.flux ?? Data.xrayFluxFromClass(ham?.xray);
        return {ham, kpNow, xrayFlux};
    }

    _recompute() {
        if (this._destroyed || !this._location)
            return;
        const now = Date.now();
        const {lat, lon} = this._location;
        const {ham, kpNow, xrayFlux} = this._inputs();

        this._sun = Solar.sunReport(lat, lon, now);

        const hasData = ham?.sfi > 0 || kpNow !== null;
        this._forecast = hasData ? Model.buildForecast({
            lat,
            lon,
            now,
            sfi: ham?.sfi,
            ssn: ham?.ssn,
            kpNow,
            kpForecast: this._raw.kpForecast,
            xrayFlux,
            protonFlux: ham?.protonFlux,
            noiseEnv: this._settings.get_string('noise-environment'),
            signalNoise: ham?.signalNoise,
            hamqslBands: ham?.bands,
            vhf: ham?.vhf,
            ionosondes: this._raw.ionosondes,
            useIonosondes: this._settings.get_boolean('use-ionosondes'),
        }) : null;

        this._render();
    }

    // ── Rendering ────────────────────────────────────────────────────────

    _useUtc() {
        return this._settings.get_boolean('use-utc');
    }

    _fmt(ms, format = '%H:%M') {
        let dt = GLib.DateTime.new_from_unix_utc(Math.floor(ms / 1000));
        if (!this._useUtc())
            dt = dt.to_local();
        return dt.format(format);
    }

    _render() {
        try {
            this._renderPanel();
            this._renderHeader();
            this._renderSummary();
            this._renderTiles();
            this._renderIonosphere();
            this._renderSun();
            this._renderOutlook();
            this._renderReference();
            this._renderFooter();
        } catch (e) {
            console.error(`[HF Propagation] render: ${e}\n${e.stack}`);
        }
    }

    _renderPanel() {
        const f = this._forecast;
        const {ham, kpNow} = this._inputs();
        const items = this._panelItems;

        items.sfi.value.text = fmtNumber(ham?.sfi);
        items.kp.value.text = kpNow === null ? '–' : `${Math.round(kpNow)}`;
        setCondition(items.kp.value, kpNow !== null && kpNow >= 4 ? kpCondition(kpNow) : null, 'hfp-c-');
        items.muf.value.text = f ? fmtNumber(f.muf) : '–';

        const best = f?.bands.filter(b => b.score >= 0.33).sort((a, b) => b.score - a.score)[0];
        items.best.value.text = best ? best.id : '–';
        setCondition(this._panelDot, f ? f.overall.condition : null, 'hfp-dot-');

        if (!f)
            this.accessible_name = 'HF Propagation';
        else
            this.accessible_name = `HF Propagation: ${Model.CONDITION_LABELS[f.overall.condition]}`;
    }

    _renderHeader() {
        const loc = this._location;
        if (loc) {
            let name = loc.locator;
            if (loc.label)
                name += ` · ${loc.label}${loc.approximate ? ' (from time zone)' : ''}`;
            this._subtitle.text = `${name} · ${fmtNumber(Math.abs(loc.lat), 2)}°${loc.lat >= 0 ? 'N' : 'S'} ${fmtNumber(Math.abs(loc.lon), 2)}°${loc.lon >= 0 ? 'E' : 'W'}`;
        }

        const scales = this._raw.scales;
        for (const k of ['R', 'S', 'G']) {
            const badge = this._scaleBadges[k];
            const level = scales?.[k]?.level;
            badge.text = level === null || level === undefined ? `${k}–` : `${k}${level}`;
            for (let i = 0; i <= 5; i++)
                badge.remove_style_class_name(`hfp-badge-${i}`);
            if (level !== null && level !== undefined)
                badge.add_style_class_name(`hfp-badge-${Math.min(5, level)}`);
        }
    }

    _renderSummary() {
        const f = this._forecast;
        const {ham, kpNow, xrayFlux} = this._inputs();

        if (!f) {
            this._gauge.setValue(0, 'closed');
            this._gaugeValue.text = '–';
            this._headline.text = Object.values(this._status).some(s => !s.ok) ? 'No data available' : 'Waiting for data…';
            this._summaryDetail.text = Object.values(this._status).some(s => !s.ok)
                ? 'Could not reach the data sources. Retrying automatically.'
                : 'Fetching solar and ionospheric data';
            this._bestNowBox.destroy_all_children();
            this._bestRow.hide();
            return;
        }
        this._bestRow.show();

        const index = Math.round(f.overall.score * 100);
        this._gauge.setValue(f.overall.score, f.overall.condition);
        this._gaugeValue.text = `${index}`;

        let headline = HEADLINES[f.overall.condition];
        let detail;
        const scales = this._raw.scales;
        const sunlit = this._sun?.elevation > -6;
        const recentPeak = (this._raw.xray?.series ?? [])
            .filter(p => p.time > Date.now() - HOUR)
            .reduce((m, p) => Math.max(m, p.flux), xrayFlux ?? 0);
        if ((scales?.R?.level >= 1 || recentPeak >= 1e-5) && sunlit) {
            headline = 'Radio blackout';
            detail = `${Data.xrayClass(recentPeak) ?? 'Strong'} flare: extra D-layer absorption on the sunlit side, low bands hit hardest.`;
        } else if (kpNow >= 5) {
            headline = 'Geomagnetic storm';
            detail = `Kp ${fmtNumber(kpNow, 1)}: high-latitude and polar paths degraded, watch 6 m for aurora.`;
        } else if (ham?.protonFlux >= 10) {
            headline = 'Solar proton event';
            detail = 'Polar cap absorption: transpolar paths are likely closed.';
        } else if (f.muf >= 24) {
            detail = `Upper HF wide open with a ${fmtNumber(f.muf, 1)} MHz MUF.`;
        } else if (f.muf >= 15) {
            detail = `Mid bands carry the DX, MUF ${fmtNumber(f.muf, 1)} MHz.`;
        } else {
            detail = `Low bands favoured, MUF ${fmtNumber(f.muf, 1)} MHz.`;
        }
        if (this._sun?.greyline.active)
            detail += ' Grey line is passing over you now.';
        else if (kpNow !== null && kpNow < 3 && !/storm|blackout|proton/i.test(headline))
            detail += ' Geomagnetic field quiet.';

        this._headline.text = headline;
        this._summaryDetail.text = detail;

        this._bestNowBox.destroy_all_children();
        const best = f.bands.filter(b => b.score >= 0.33).sort((a, b) => b.score - a.score).slice(0, 3);
        if (best.length === 0)
            this._bestNowBox.add_child(W.label('none open', 'hfp-chip-empty'));
        for (const b of best) {
            const chip = W.label(b.id, 'hfp-pill hfp-chip');
            setCondition(chip, b.condition);
            this._bestNowBox.add_child(chip);
        }
    }

    _renderTiles() {
        const t = this._tiles;
        const f = this._forecast;
        const {ham, kpNow, xrayFlux} = this._inputs();

        // Solar flux.
        const sfi = ham?.sfi ?? null;
        t.sfi.value.text = fmtNumber(sfi);
        let sfiText = '', sfiCond = null;
        if (sfi !== null) {
            [sfiText, sfiCond] = sfi >= 200 ? ['Very high', 'excellent']
                : sfi >= 150 ? ['High', 'excellent']
                    : sfi >= 120 ? ['Good', 'good']
                        : sfi >= 90 ? ['Moderate', 'fair']
                            : ['Low', 'poor'];
        }
        t.sfi.caption.text = sfiText;
        setCondition(t.sfi.caption, sfiCond, 'hfp-c-');

        // Sunspots.
        t.ssn.value.text = fmtNumber(ham?.ssn);
        t.ssn.caption.text = f ? `Effective ${Math.round(f.ssn)}` : '';

        // Kp.
        t.kp.value.text = kpNow === null ? '–' : fmtNumber(kpNow, Number.isInteger(kpNow) ? 0 : 1);
        t.kp.aside.text = kpNow === null ? '' : kpText(kpNow);
        setCondition(t.kp.aside, kpCondition(kpNow), 'hfp-c-');
        const history = (this._raw.kpHistory ?? []).slice(-8).map(k => k.kp);
        const now = Date.now();
        const forecast = (this._raw.kpForecast ?? [])
            .filter(k => k.time > now - 3 * HOUR && !/observed/i.test(k.kind))
            .slice(0, 8)
            .map(k => k.kp);
        this._kpBars.setData(history, forecast);

        // A index.
        const a = ham?.aIndex ?? null;
        t.a.value.text = fmtNumber(a);
        let aText = '', aCond = null;
        if (a !== null) {
            [aText, aCond] = a >= 50 ? ['Major storm', 'closed']
                : a >= 30 ? ['Minor storm', 'poor']
                    : a >= 16 ? ['Active', 'fair']
                        : a >= 8 ? ['Unsettled', 'good']
                            : ['Quiet', 'excellent'];
        }
        t.a.caption.text = aText;
        setCondition(t.a.caption, aCond, 'hfp-c-');

        // X-ray.
        const xcls = Data.xrayClass(xrayFlux) ?? ham?.xray ?? null;
        t.xray.value.text = xcls ?? '–';
        const xcond = !xrayFlux ? null : xrayFlux >= 1e-4 ? 'closed' : xrayFlux >= 1e-5 ? 'poor' : xrayFlux >= 1e-6 ? 'fair' : 'excellent';
        setCondition(t.xray.value, xcond, 'hfp-c-');
        const peak = this._raw.xray?.peak;
        t.xray.aside.text = peak ? `max ${Data.xrayClass(peak)}` : '';
        this._xraySpark.setSeries(this._raw.xray?.series ?? []);

        // Solar wind.
        const wind = ham?.solarWind ?? null;
        t.wind.value.text = fmtNumber(wind);
        let wText = '', wCond = null;
        if (wind !== null) {
            [wText, wCond] = wind >= 700 ? ['Very fast', 'poor']
                : wind >= 500 ? ['Elevated', 'fair']
                    : ['Normal', 'excellent'];
        }
        t.wind.caption.text = wText;
        setCondition(t.wind.caption, wCond, 'hfp-c-');

        // Bz.
        const bz = ham?.bz ?? null;
        t.bz.value.text = bz === null ? '–' : `${bz > 0 ? '+' : bz < 0 ? '−' : ''}${Math.abs(bz).toFixed(1)}`;
        let bzText = '', bzCond = null;
        if (bz !== null) {
            [bzText, bzCond] = bz <= -10 ? ['Strongly south', 'poor']
                : bz <= -5 ? ['Southward', 'fair']
                    : bz < 0 ? ['Slightly south', 'good']
                        : ['Northward', 'excellent'];
        }
        t.bz.caption.text = bzText;
        setCondition(t.bz.caption, bzCond, 'hfp-c-');

        // Protons.
        const pf = ham?.protonFlux ?? null;
        t.protons.value.text = pf === null ? '–' : pf >= 10 ? fmtNumber(pf, 0) : fmtNumber(pf, 2);
        let pText = '', pCond = null;
        if (pf !== null) {
            const sLevel = pf >= 1e5 ? 5 : pf >= 1e4 ? 4 : pf >= 1e3 ? 3 : pf >= 100 ? 2 : pf >= 10 ? 1 : 0;
            pText = sLevel === 0 ? 'S0 · Quiet' : `S${sLevel} · Radiation storm`;
            pCond = sLevel === 0 ? 'excellent' : sLevel === 1 ? 'fair' : 'poor';
        }
        t.protons.caption.text = pText;
        setCondition(t.protons.caption, pCond, 'hfp-c-');
    }

    _renderIonosphere() {
        const f = this._forecast;
        const m = this._metrics;
        const {ham} = this._inputs();

        if (!f) {
            for (const k of Object.keys(m)) {
                m[k].value.text = '–';
                m[k].caption.text = '';
            }
            this._spectrum.setWindow(null, null, null);
            this._spectrumCaption.text = '';
            this._ionoAside.text = '';
            return;
        }

        m.muf.value.text = fmtNumber(f.muf, 1);
        const st = f.calibration.stations[0];
        m.muf.caption.text = st ? `${st.name} · ${Math.round(st.distance)} km` : 'Model estimate';
        this._ionoAside.text = st ? 'Ionosonde calibrated' : 'Modelled';

        m.fof2.value.text = fmtNumber(f.fof2, 1);
        m.fof2.caption.text = `NVIS up to ${fmtNumber(f.fof2 * 0.9, 1)} MHz`;

        m.absorption.value.text = f.absorptionLevel;
        const absCond = {Low: 'excellent', Moderate: 'good', High: 'fair', Severe: 'poor'}[f.absorptionLevel];
        setCondition(m.absorption.value, absCond, 'hfp-c-');
        m.absorption.caption.text = `${fmtNumber(f.absorption10, 1)} dB at 10 MHz`;

        const ref = f.bands.find(b => b.id === '20m');
        m.noise.value.text = Model.formatS(ref.noise.s);
        const env = Model.NOISE_ENVIRONMENTS[this._settings.get_string('noise-environment')] ??
            Model.NOISE_ENVIRONMENTS.residential;
        m.noise.unit.text = '@ 20 m';
        const field = ham?.geomagField ? ham.geomagField.charAt(0) + ham.geomagField.slice(1).toLowerCase() : null;
        m.noise.caption.text = field ? `${env.label} · field ${field.toLowerCase()}` : env.label;

        // Below 160 m the absorption-limited LUF has no practical meaning.
        const luf = Math.max(1.8, f.luf);
        this._spectrum.setWindow(luf, f.muf, f.fof2);
        this._spectrumCaption.text = `${fmtNumber(luf, 1)} – ${fmtNumber(f.muf, 1)} MHz`;
    }

    _renderSun() {
        const s = this._sun;
        const loc = this._location;
        if (!s || !loc)
            return;
        const kv = this._sunKv;
        const now = Date.now();

        this._map.update(now, loc, this._forecast?.calibration.stations ?? []);

        if (s.polar) {
            kv.sunrise.value.text = s.polar === 'day' ? 'Polar day' : 'Polar night';
            kv.sunrise.caption.text = '';
            kv.sunset.value.text = '–';
            kv.sunset.caption.text = '';
        } else {
            kv.sunrise.value.text = s.nextSunrise ? this._fmt(s.nextSunrise) : '–';
            kv.sunrise.caption.text = s.nextSunrise ? `in ${fmtDuration(s.nextSunrise - now)}` : '';
            kv.sunset.value.text = s.nextSunset ? this._fmt(s.nextSunset) : '–';
            kv.sunset.caption.text = s.nextSunset ? `in ${fmtDuration(s.nextSunset - now)}` : '';
        }

        kv.sun.value.text = `${fmtNumber(s.elevation, 1)}°`;
        const phase = Solar.phaseForElevation(s.elevation);
        kv.sun.caption.text = `Az ${fmtNumber(s.azimuth)}° · ${{day: 'daylight', greyline: 'twilight', night: 'night'}[phase]}`;

        const g = s.greyline;
        if (g.active) {
            kv.greyline.value.text = 'Active now';
            kv.greyline.caption.text = `${g.active.kind === 'dawn' ? 'Dawn' : 'Dusk'} until ${this._fmt(g.active.end)}`;
            kv.greyline.value.add_style_class_name('hfp-c-greyline');
        } else if (g.next.length) {
            const n = g.next[0];
            kv.greyline.value.text = `${this._fmt(n.start)}–${this._fmt(n.end)}`;
            kv.greyline.caption.text = `${n.kind === 'dawn' ? 'Dawn' : 'Dusk'} in ${fmtDuration(n.start - now)}`;
            kv.greyline.value.remove_style_class_name('hfp-c-greyline');
        } else {
            kv.greyline.value.text = '–';
            kv.greyline.caption.text = '';
        }

        this._sunAside.text = s.dayLengthMs ? `Day ${fmtDuration(s.dayLengthMs)}` : '';
    }

    _renderOutlook() {
        const f = this._forecast;
        this._outlookAside.text = `Next 24 h · ${this._useUtc() ? 'UTC' : 'local time'}`;

        if (!f) {
            for (const row of Object.values(this._bandRows)) {
                row.pill.text = '–';
                setCondition(row.pill, null);
                row.strip.setData([], null, -1);
                row.best.text = '–';
                row.noise.text = '–';
            }
            return;
        }

        this._hourLabels.forEach((l, i) => {
            l.text = this._fmt(f.hours[i * 3].start, '%H');
        });
        this._daylight.setPhases(f.hours.map(h => h.phase));

        let midnight = -1;
        for (let i = 1; i < f.hours.length; i++) {
            if (this._fmt(f.hours[i].start, '%H') === '00') {
                midnight = i;
                break;
            }
        }

        for (const b of f.bands) {
            const row = this._bandRows[b.id];
            row.pill.text = Model.CONDITION_LABELS[b.condition];
            setCondition(row.pill, b.condition);
            row.strip.setData(b.hourly, b.best, midnight);
            if (!b.best) {
                row.best.text = '—';
            } else if (b.best.allDay) {
                row.best.text = 'All day';
            } else {
                const start = b.best.startsNow ? 'Now' : this._fmt(b.best.start, '%H');
                row.best.text = `${start}–${this._fmt(b.best.end, '%H')}`;
            }
            row.noise.text = Model.formatS(b.noise.s);
            const ns = b.noise.s;
            setCondition(row.noise, ns >= 8 ? 'poor' : ns >= 6 ? 'fair' : null, 'hfp-c-');
        }
    }

    _renderReference() {
        const ham = this._raw.hamqsl;
        for (const g of REFERENCE_GROUPS) {
            for (const time of ['day', 'night']) {
                const pill = this._refPills[`${g}/${time}`];
                const text = ham?.bands?.[g]?.[time] ?? null;
                pill.text = text ?? '–';
                const cond = {good: 'good', fair: 'fair', poor: 'poor'}[String(text).toLowerCase()] ?? null;
                setCondition(pill, cond);
            }
        }
        this._refAside.text = ham?.updated ? `Issued ${ham.updated}` : '';

        this._vhfBox.destroy_all_children();
        for (const p of ham?.vhf ?? []) {
            const name = VHF_NAMES[`${p.name}/${p.location}`] ?? `${p.name} ${p.location}`;
            const open = !/closed/i.test(p.value);
            const chip = W.hbox({style_class: `hfp-vhf-chip${open ? ' hfp-vhf-open' : ''}`});
            chip.add_child(new St.Widget({style_class: 'hfp-vhf-dot', y_align: Clutter.ActorAlign.CENTER}));
            chip.add_child(W.label(name, 'hfp-vhf-name'));
            if (open)
                chip.add_child(W.label(p.value, 'hfp-vhf-value'));
            this._vhfBox.add_child(chip);
        }
    }

    _renderFooter() {
        const st = this._status;
        const cached = !!st.cached;
        const state = (keys) => {
            if (cached)
                return 'stale';
            const known = keys.filter(k => st[k]);
            if (known.length === 0)
                return 'pending';
            return known.every(k => st[k].ok) ? 'ok' : known.some(k => st[k].ok) ? 'partial' : 'error';
        };
        const states = {
            hamqsl: state(['hamqsl']),
            noaa: state(['kpNow', 'kpHistory', 'kpForecast', 'scales', 'xray']),
            kc2g: this._settings.get_boolean('use-ionosondes') ? state(['ionosondes']) : 'off',
        };
        for (const [k, {item, dot}] of Object.entries(this._sourceDots)) {
            for (const s of ['ok', 'partial', 'error', 'pending', 'stale', 'off'])
                dot.remove_style_class_name(`hfp-source-${s}`);
            dot.add_style_class_name(`hfp-source-${states[k]}`);
            item.visible = states[k] !== 'off';
        }

        const every = Math.max(5, this._settings.get_int('refresh-interval'));
        const offline = !cached && Object.keys(st).length > 0 && Object.values(st).every(s => !s.ok);
        if (offline && this._lastFetch) {
            this._updatedLabel.text = `Offline · showing data from ${this._fmt(this._lastFetch)}`;
        } else if (offline) {
            this._updatedLabel.text = 'Offline · retrying';
        } else if (this._lastFetch) {
            const age = Date.now() - this._lastFetch;
            const when = age < 2 * MINUTE ? 'just now' : `${fmtDuration(age)} ago`;
            this._updatedLabel.text = `${cached ? 'Cached' : 'Updated'} ${when} · every ${every} min`;
        } else {
            this._updatedLabel.text = this._refreshing ? 'Updating…' : `Refresh every ${every} min`;
        }
    }

    destroy() {
        this._destroyed = true;
        this._stopTimers();
        if (this._networkChangedId) {
            this._networkMonitor.disconnect(this._networkChangedId);
            this._networkChangedId = 0;
        }
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._fetcher?.destroy();
        this._fetcher = null;
        this._settings = null;
        super.destroy();
    }
});

export function addIndicator(indicator, position) {
    const box = ['left', 'center', 'right'].includes(position) ? position : 'right';
    Main.panel.addToStatusArea('hf-propagation-indicator', indicator, box === 'right' ? 0 : -1, box);
}
