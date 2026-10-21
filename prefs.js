// SPDX-FileCopyrightText: 2025 Mateusz Kaduk
// SPDX-License-Identifier: GPL-3.0-or-later

// Preferences window for the HF Propagation extension.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Geo from './lib/geo.js';

const LOCATION_SOURCES = [
    ['auto', 'Automatic (time zone)'],
    ['locator', 'Maidenhead locator'],
    ['coordinates', 'Latitude / longitude'],
];

const NOISE_ENVIRONMENTS = [
    ['quiet', 'Quiet rural'],
    ['rural', 'Rural'],
    ['residential', 'Residential'],
    ['city', 'City'],
];

const PANEL_POSITIONS = [
    ['left', 'Left'],
    ['center', 'Center'],
    ['right', 'Right'],
];

function comboRow(settings, handlers, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(c => c[1])),
    });
    const sync = () => {
        const idx = choices.findIndex(c => c[0] === settings.get_string(key));
        row.selected = Math.max(0, idx);
    };
    sync();
    row.connect('notify::selected', () => {
        const value = choices[row.selected]?.[0];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    handlers.push(settings.connect(`changed::${key}`, sync));
    return row;
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper, step, digits) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        digits,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function linkRow(title, subtitle, uri) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
    row.connect('activated', () => {
        new Gtk.UriLauncher({uri}).launch(row.get_root(), null, null);
    });
    return row;
}

export default class HFPropagationPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const handlers = [];
        window.connect('close-request', () => {
            handlers.forEach(id => settings.disconnect(id));
            handlers.length = 0;
        });
        window.set_default_size(660, 780);
        window.search_enabled = true;

        // ── General ──────────────────────────────────────────────────────
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const location = new Adw.PreferencesGroup({
            title: 'Station Location',
            description: 'Used for the local MUF, absorption, noise, sun and grey line calculations.',
        });
        page.add(location);

        location.add(comboRow(settings, handlers, 'location-source', 'Location source', '', LOCATION_SOURCES));

        const locatorRow = new Adw.EntryRow({
            title: 'Grid locator',
            text: settings.get_string('locator'),
            show_apply_button: false,
        });
        locatorRow.connect('changed', () => {
            const text = locatorRow.text.trim();
            if (text === '' || Geo.isValidLocator(text)) {
                locatorRow.remove_css_class('error');
                if (text !== settings.get_string('locator'))
                    settings.set_string('locator', text);
            } else {
                locatorRow.add_css_class('error');
            }
        });
        location.add(locatorRow);

        const latRow = spinRow(settings, 'latitude', 'Latitude', 'Degrees, north positive', -90, 90, 0.01, 4);
        const lonRow = spinRow(settings, 'longitude', 'Longitude', 'Degrees, east positive', -180, 180, 0.01, 4);
        location.add(latRow);
        location.add(lonRow);

        const resolvedRow = new Adw.ActionRow({title: 'Current position', subtitle: '…'});
        resolvedRow.add_prefix(new Gtk.Image({icon_name: 'find-location-symbolic'}));
        location.add(resolvedRow);

        const updateLocation = async () => {
            const source = settings.get_string('location-source');
            locatorRow.sensitive = source === 'locator';
            latRow.sensitive = source === 'coordinates';
            lonRow.sensitive = source === 'coordinates';

            let pos = null, label = '';
            if (source === 'locator') {
                pos = Geo.locatorToLatLon(settings.get_string('locator'));
                label = pos ? 'from locator' : 'enter a valid locator, e.g. JO62qm';
            } else if (source === 'coordinates') {
                pos = {lat: settings.get_double('latitude'), lon: settings.get_double('longitude')};
                label = 'from coordinates';
            }
            if (!pos) {
                try {
                    const tz = await Geo.locationFromTimeZone();
                    pos = tz;
                    label = `${source === 'auto' ? '' : 'fallback: '}${tz.label} (time zone)`;
                } catch {
                    label = 'unknown';
                }
            }
            if (pos) {
                const ns = pos.lat >= 0 ? 'N' : 'S';
                const ew = pos.lon >= 0 ? 'E' : 'W';
                resolvedRow.subtitle = `${Geo.latLonToLocator(pos.lat, pos.lon, 6)} · ` +
                    `${Math.abs(pos.lat).toFixed(2)}°${ns} ${Math.abs(pos.lon).toFixed(2)}°${ew} · ${label}`;
            } else {
                resolvedRow.subtitle = label;
            }
        };
        for (const key of ['location-source', 'locator', 'latitude', 'longitude'])
            handlers.push(settings.connect(`changed::${key}`, () => updateLocation().catch(logError)));
        updateLocation().catch(logError);

        const station = new Adw.PreferencesGroup({
            title: 'Station Environment',
        });
        page.add(station);
        station.add(comboRow(settings, handlers, 'noise-environment', 'Noise environment',
            'Man-made noise level (ITU-R P.372) used for the noise floor estimate', NOISE_ENVIRONMENTS));

        const panel = new Adw.PreferencesGroup({
            title: 'Top Bar',
        });
        page.add(panel);
        panel.add(comboRow(settings, handlers, 'panel-position', 'Position', '', PANEL_POSITIONS));
        panel.add(switchRow(settings, 'panel-show-status-dot', 'Condition dot', 'Coloured dot with the overall HF condition'));
        panel.add(switchRow(settings, 'panel-show-sfi', 'Solar flux (SFI)'));
        panel.add(switchRow(settings, 'panel-show-kp', 'Kp index'));
        panel.add(switchRow(settings, 'panel-show-muf', 'Local MUF'));
        panel.add(switchRow(settings, 'panel-show-best-band', 'Best band now'));

        const data = new Adw.PreferencesGroup({
            title: 'Data',
        });
        page.add(data);
        data.add(spinRow(settings, 'refresh-interval', 'Refresh interval', 'Minutes between downloads', 5, 180, 5, 0));
        data.add(switchRow(settings, 'use-ionosondes', 'Ionosonde calibration',
            'Calibrate the local MUF with nearby ionosondes (KC2G / GIRO)'));
        data.add(switchRow(settings, 'use-utc', 'Show times in UTC', 'Otherwise local time is used'));

        // ── About ────────────────────────────────────────────────────────
        const about = new Adw.PreferencesPage({
            title: 'About',
            icon_name: 'help-about-symbolic',
        });
        window.add(about);

        const info = new Adw.PreferencesGroup({
            title: 'HF Propagation',
            description: `Version ${this.metadata['version-name'] ?? this.metadata.version}. ` +
                'Band conditions combine N0NBH\'s calculated conditions with a local ' +
                'ionospheric model (MUF, D-layer and flare absorption, ITU-R P.372 noise, ' +
                'sporadic-E climatology), calibrated against nearby ionosondes.',
        });
        about.add(info);

        const sources = new Adw.PreferencesGroup({title: 'Data Sources'});
        about.add(sources);
        sources.add(linkRow('N0NBH / HamQSL', 'Solar indices and band group conditions', 'https://www.hamqsl.com/solar.html'));
        sources.add(linkRow('NOAA SWPC', 'Kp, X-ray flux and space weather scales', 'https://www.swpc.noaa.gov/'));
        sources.add(linkRow('KC2G', 'Real-time ionosonde MUF and foF2', 'https://prop.kc2g.com/'));
        sources.add(linkRow('Natural Earth', 'Coastlines for the world map (public domain)', 'https://www.naturalearthdata.com/'));
        sources.add(linkRow('Project page', this.metadata.url, this.metadata.url));
    }
}
