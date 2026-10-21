// SPDX-FileCopyrightText: 2025 Mateusz Kaduk
// SPDX-License-Identifier: GPL-3.0-or-later

// Data acquisition: HamQSL (N0NBH) solar XML, NOAA SWPC JSON products and
// KC2G ionosonde measurements. Every source is optional; the parsers are
// defensive because upstream formats occasionally change.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

export const SOURCES = {
    hamqsl: 'https://www.hamqsl.com/solarxml.php',
    kpNow: 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json',
    kpHistory: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
    kpForecast: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
    scales: 'https://services.swpc.noaa.gov/products/noaa-scales.json',
    xray: 'https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json',
    ionosondes: 'https://prop.kc2g.com/api/stations.json?maxage=7200',
};

const USER_AGENT = 'gnome-shell-hf-propagation/2.0 (+https://github.com/mashu/hf-propagation)';

function num(value) {
    if (value === null || value === undefined)
        return null;
    const n = typeof value === 'number' ? value : parseFloat(String(value).trim());
    return Number.isFinite(n) ? n : null;
}

/**
 * Parse the many timestamp spellings used by the sources as UTC.
 *
 * @param {string} text - e.g. "2026-10-20 12:00:00.000" or "2026-10-20T12:00:00"
 * @returns {number|null} ms since epoch
 */
export function parseUtc(text) {
    if (!text)
        return null;
    let s = String(text).trim().replace(' ', 'T');
    if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s))
        s += 'Z';
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
}

/**
 * Convert NOAA "products" tables (array of arrays with a header row) and
 * plain arrays of objects into arrays of objects.
 *
 * @param {Array} json - parsed JSON
 * @returns {Array<object>}
 */
export function tableToObjects(json) {
    if (!Array.isArray(json) || json.length === 0)
        return [];
    if (Array.isArray(json[0])) {
        const header = json[0].map(h => String(h));
        return json.slice(1).map(row => Object.fromEntries(header.map((h, i) => [h, row[i]])));
    }
    return json.filter(o => o && typeof o === 'object');
}

function pick(obj, ...keys) {
    for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== null)
            return obj[k];
    }
    return null;
}

/**
 * Convert a GOES X-ray flux (W/m²) to its flare class, e.g. 3.2e-6 → "C3.2".
 *
 * @param {number} flux - 0.1–0.8 nm flux
 * @returns {string|null}
 */
export function xrayClass(flux) {
    if (!(flux > 0))
        return null;
    const classes = [['X', 1e-4], ['M', 1e-5], ['C', 1e-6], ['B', 1e-7], ['A', 1e-8]];
    for (const [letter, base] of classes) {
        if (flux >= base)
            return `${letter}${(flux / base).toFixed(1)}`;
    }
    return `A${(flux / 1e-8).toFixed(1)}`;
}

/**
 * Inverse of xrayClass().
 *
 * @param {string} text - e.g. "M1.4"
 * @returns {number|null} flux in W/m²
 */
export function xrayFluxFromClass(text) {
    const m = /^\s*([ABCMX])\s*([0-9.]+)/i.exec(text ?? '');
    if (!m)
        return null;
    const base = {A: 1e-8, B: 1e-7, C: 1e-6, M: 1e-5, X: 1e-4}[m[1].toUpperCase()];
    const v = parseFloat(m[2]);
    return Number.isFinite(v) ? base * v : null;
}

/**
 * @param {string} xml - HamQSL solar XML
 * @returns {object}
 */
export function parseHamQSL(xml) {
    const tag = name => {
        const m = new RegExp(`<${name}>([^<]*)</${name}>`, 'i').exec(xml);
        return m ? m[1].trim() : null;
    };

    if (!/<solardata>/i.test(xml))
        throw new Error('Unexpected HamQSL response');

    const bands = {};
    const bandRe = /<band\s+name="([^"]+)"\s+time="([^"]+)"\s*>([^<]*)<\/band>/gi;
    for (const m of xml.matchAll(bandRe)) {
        const name = m[1].trim();
        bands[name] ??= {};
        bands[name][m[2].trim().toLowerCase()] = m[3].trim();
    }

    const vhf = [];
    const vhfRe = /<phenomenon\s+name="([^"]+)"\s+location="([^"]+)"\s*>([^<]*)<\/phenomenon>/gi;
    for (const m of xml.matchAll(vhfRe))
        vhf.push({name: m[1].trim(), location: m[2].trim(), value: m[3].trim()});

    return {
        updated: tag('updated'),
        sfi: num(tag('solarflux')),
        aIndex: num(tag('aindex')),
        kIndex: num(tag('kindex')),
        xray: tag('xray'),
        ssn: num(tag('sunspots')),
        heliumLine: num(tag('heliumline')),
        protonFlux: num(tag('protonflux')),
        electronFlux: num(tag('electonflux')) ?? num(tag('electronflux')),
        aurora: num(tag('aurora')),
        auroraLat: num(tag('latdegree')),
        solarWind: num(tag('solarwind')),
        bz: num(tag('magneticfield')),
        geomagField: tag('geomagfield'),
        signalNoise: tag('signalnoise'),
        fof2: num(tag('fof2')),
        muf: num(tag('muf')),
        bands,
        vhf,
    };
}

/**
 * @param {Array} json - planetary_k_index_1m.json
 * @returns {{kp: number, time: number}|null}
 */
export function parseKpNow(json) {
    const rows = tableToObjects(json);
    for (let i = rows.length - 1; i >= 0; i--) {
        const kp = num(pick(rows[i], 'estimated_kp', 'kp_index', 'Kp', 'kp'));
        if (kp !== null)
            return {kp, time: parseUtc(pick(rows[i], 'time_tag', 'time'))};
    }
    return null;
}

/**
 * @param {Array} json - noaa-planetary-k-index.json (3-hourly observed Kp)
 * @returns {Array<{time: number, kp: number}>}
 */
export function parseKpHistory(json) {
    return tableToObjects(json)
        .map(r => ({
            time: parseUtc(pick(r, 'time_tag', 'time')),
            kp: num(pick(r, 'Kp', 'kp', 'kp_index', 'estimated_kp')),
        }))
        .filter(r => r.time !== null && r.kp !== null);
}

/**
 * @param {Array} json - noaa-planetary-k-index-forecast.json
 * @returns {Array<{time: number, kp: number, kind: string}>}
 */
export function parseKpForecast(json) {
    return tableToObjects(json)
        .map(r => ({
            time: parseUtc(pick(r, 'time_tag', 'time')),
            kp: num(pick(r, 'kp', 'Kp', 'predicted_kp')),
            kind: String(pick(r, 'observed', 'kind', 'type') ?? 'predicted'),
        }))
        .filter(r => r.time !== null && r.kp !== null);
}

/**
 * @param {object} json - noaa-scales.json
 * @returns {{R: object, S: object, G: object}|null}
 */
export function parseScales(json) {
    const now = json?.['0'] ?? json?.[0];
    if (!now)
        return null;
    const scale = k => ({
        level: num(now[k]?.Scale) ?? 0,
        text: now[k]?.Text ?? 'none',
    });
    return {R: scale('R'), S: scale('S'), G: scale('G')};
}

/**
 * @param {Array} json - GOES xrays-6-hour.json
 * @returns {{flux: number, time: number, series: Array<{time: number, flux: number}>, peak: number}|null}
 */
export function parseXray(json) {
    const series = tableToObjects(json)
        .filter(r => String(r.energy ?? '').startsWith('0.1-0.8'))
        .map(r => ({time: parseUtc(r.time_tag), flux: num(r.flux ?? r.observed_flux)}))
        .filter(r => r.time !== null && r.flux !== null && r.flux > 0)
        .sort((a, b) => a.time - b.time);
    if (series.length === 0)
        return null;
    const last = series[series.length - 1];
    const peak = Math.max(...series.map(s => s.flux));
    return {flux: last.flux, time: last.time, series, peak};
}

/**
 * @param {Array} json - KC2G stations.json
 * @returns {Array<object>}
 */
export function parseIonosondes(json) {
    if (!Array.isArray(json))
        return [];
    const out = [];
    for (const m of json) {
        const st = m?.station ?? {};
        const lat = num(st.latitude);
        let lon = num(st.longitude);
        const mufd = num(m.mufd);
        const cs = num(m.cs);
        if (lat === null || lon === null || mufd === null || mufd <= 0)
            continue;
        // Confidence score: negative means manually scaled (good), 0–100 autoscaled.
        if (cs !== null && cs >= 0 && cs < 25)
            continue;
        if (lon > 180)
            lon -= 360;
        out.push({
            name: st.name ?? st.code ?? 'Ionosonde',
            code: st.code ?? '',
            lat,
            lon,
            mufd,
            fof2: num(m.fof2),
            md: num(m.md),
            time: parseUtc(m.time),
            confidence: cs,
        });
    }
    return out;
}

/**
 * Thin promise wrapper around a Soup 3 session.
 */
export class Fetcher {
    constructor() {
        this._session = new Soup.Session({
            user_agent: USER_AGENT,
            timeout: 20,
            max_conns_per_host: 2,
        });
        this._cancellables = new Set();
    }

    /**
     * @param {string} url - resource to fetch
     * @returns {Promise<string>}
     */
    fetchText(url) {
        return new Promise((resolve, reject) => {
            const message = Soup.Message.new('GET', url);
            if (!message) {
                reject(new Error(`Invalid URL ${url}`));
                return;
            }
            message.request_headers.append('Accept', 'application/json, text/xml, */*');
            message.request_headers.append('Cache-Control', 'no-cache');

            const cancellable = new Gio.Cancellable();
            this._cancellables.add(cancellable);

            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable,
                (session, result) => {
                    this._cancellables.delete(cancellable);
                    try {
                        const bytes = session.send_and_read_finish(result);
                        const status = message.get_status();
                        if (status !== Soup.Status.OK)
                            throw new Error(`HTTP ${status} ${message.get_reason_phrase() ?? ''}`.trim());
                        const data = bytes.get_data();
                        resolve(data ? new TextDecoder('utf-8').decode(data) : '');
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    /**
     * @param {string} url - resource to fetch
     * @returns {Promise<any>}
     */
    async fetchJson(url) {
        return JSON.parse(await this.fetchText(url));
    }

    destroy() {
        for (const c of this._cancellables)
            c.cancel();
        this._cancellables.clear();
        this._session?.abort();
        this._session = null;
    }
}

/**
 * Fetch every source in parallel. Failures are reported per source instead
 * of failing the whole refresh.
 *
 * @param {Fetcher} fetcher - HTTP helper
 * @param {object} [options] - what to fetch
 * @param {boolean} [options.ionosondes] - also fetch KC2G ionosonde data
 * @returns {Promise<{data: object, status: object}>}
 */
export async function fetchAll(fetcher, {ionosondes = true} = {}) {
    const jobs = {
        hamqsl: () => fetcher.fetchText(SOURCES.hamqsl).then(parseHamQSL),
        kpNow: () => fetcher.fetchJson(SOURCES.kpNow).then(parseKpNow),
        kpHistory: () => fetcher.fetchJson(SOURCES.kpHistory).then(parseKpHistory),
        kpForecast: () => fetcher.fetchJson(SOURCES.kpForecast).then(parseKpForecast),
        scales: () => fetcher.fetchJson(SOURCES.scales).then(parseScales),
        xray: () => fetcher.fetchJson(SOURCES.xray).then(parseXray),
    };
    if (ionosondes)
        jobs.ionosondes = () => fetcher.fetchJson(SOURCES.ionosondes).then(parseIonosondes);

    const keys = Object.keys(jobs);
    const results = await Promise.allSettled(keys.map(k => jobs[k]()));

    const data = {};
    const status = {};
    keys.forEach((k, i) => {
        const r = results[i];
        if (r.status === 'fulfilled') {
            data[k] = r.value;
            status[k] = {ok: true};
        } else {
            data[k] = null;
            status[k] = {ok: false, error: r.reason?.message ?? String(r.reason)};
        }
    });
    return {data, status, time: Date.now()};
}
