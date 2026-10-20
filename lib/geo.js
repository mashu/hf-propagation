// Geographic helpers: Maidenhead locators, great-circle distance and a
// zero-configuration location guess based on the system time zone.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const RAD = Math.PI / 180;

/**
 * @param {string} locator - Maidenhead grid locator (2–8 characters)
 * @returns {boolean}
 */
export function isValidLocator(locator) {
    return /^[A-R]{2}([0-9]{2}([A-X]{2}([0-9]{2})?)?)?$/i.test((locator ?? '').trim());
}

/**
 * Convert a Maidenhead locator to the coordinates of its centre.
 *
 * @param {string} locator - grid locator, e.g. "JO62qm"
 * @returns {{lat: number, lon: number}|null}
 */
export function locatorToLatLon(locator) {
    if (!isValidLocator(locator))
        return null;

    const loc = locator.trim().toUpperCase();
    let lon = -180, lat = -90;
    let lonSize = 20, latSize = 10;

    lon += (loc.charCodeAt(0) - 65) * lonSize;
    lat += (loc.charCodeAt(1) - 65) * latSize;

    if (loc.length >= 4) {
        lonSize = 2;
        latSize = 1;
        lon += parseInt(loc[2]) * lonSize;
        lat += parseInt(loc[3]) * latSize;
    }
    if (loc.length >= 6) {
        lonSize = 2 / 24;
        latSize = 1 / 24;
        lon += (loc.charCodeAt(4) - 65) * lonSize;
        lat += (loc.charCodeAt(5) - 65) * latSize;
    }
    if (loc.length >= 8) {
        lonSize /= 10;
        latSize /= 10;
        lon += parseInt(loc[6]) * lonSize;
        lat += parseInt(loc[7]) * latSize;
    }

    return {lat: lat + latSize / 2, lon: lon + lonSize / 2};
}

/**
 * Convert coordinates to a Maidenhead locator.
 *
 * @param {number} lat - degrees
 * @param {number} lon - degrees
 * @param {number} [length] - 4, 6 or 8 characters
 * @returns {string}
 */
export function latLonToLocator(lat, lon, length = 6) {
    let x = Math.min(Math.max(lon + 180, 0), 359.99999);
    let y = Math.min(Math.max(lat + 90, 0), 179.99999);

    let out = '';
    out += String.fromCharCode(65 + Math.floor(x / 20));
    out += String.fromCharCode(65 + Math.floor(y / 10));
    x %= 20;
    y %= 10;
    out += Math.floor(x / 2);
    out += Math.floor(y);
    if (length >= 6) {
        x %= 2;
        y %= 1;
        out += String.fromCharCode(97 + Math.floor(x * 12));
        out += String.fromCharCode(97 + Math.floor(y * 24));
    }
    if (length >= 8) {
        x = (x * 12) % 1;
        y = (y * 24) % 1;
        out += Math.floor(x * 10);
        out += Math.floor(y * 10);
    }
    return out;
}

/**
 * Great-circle distance.
 *
 * @param {number} lat1 - degrees
 * @param {number} lon1 - degrees
 * @param {number} lat2 - degrees
 * @param {number} lon2 - degrees
 * @returns {number} kilometres
 */
export function distanceKm(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * RAD;
    const dLon = (lon2 - lon1) * RAD;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function parseIsoCoordinate(text, degDigits) {
    const sign = text[0] === '-' ? -1 : 1;
    const body = text.slice(1);
    const deg = parseInt(body.slice(0, degDigits));
    const min = parseInt(body.slice(degDigits, degDigits + 2));
    const sec = body.length > degDigits + 2 ? parseInt(body.slice(degDigits + 2, degDigits + 4)) : 0;
    return sign * (deg + min / 60 + sec / 3600);
}

/**
 * Parse an ISO 6709 coordinate pair as used by zone.tab, e.g. "+5920+01803".
 *
 * @param {string} text - coordinate pair
 * @returns {{lat: number, lon: number}|null}
 */
export function parseIso6709(text) {
    const m = /^([+-]\d{4,6})([+-]\d{5,7})$/.exec(text);
    if (!m)
        return null;
    const lat = parseIsoCoordinate(m[1], 2);
    const lon = parseIsoCoordinate(m[2], 3);
    return {lat, lon};
}

function loadFile(path) {
    return new Promise((resolve, reject) => {
        const file = Gio.File.new_for_path(path);
        file.load_contents_async(null, (f, res) => {
            try {
                const [, contents] = f.load_contents_finish(res);
                resolve(new TextDecoder('utf-8').decode(contents));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * Guess the station location from the system time zone. This is only a
 * fallback so the extension is useful before the user enters a locator.
 *
 * @returns {Promise<{lat: number, lon: number, label: string}>}
 */
export async function locationFromTimeZone() {
    const tz = GLib.TimeZone.new_local();
    const id = tz.get_identifier();

    for (const path of ['/usr/share/zoneinfo/zone1970.tab', '/usr/share/zoneinfo/zone.tab']) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const text = await loadFile(path);
            for (const line of text.split('\n')) {
                if (line.startsWith('#'))
                    continue;
                const cols = line.split('\t');
                if (cols.length >= 3 && cols[2] === id) {
                    const pos = parseIso6709(cols[1]);
                    if (pos) {
                        const city = id.split('/').pop().replace(/_/g, ' ');
                        return {...pos, label: city};
                    }
                }
            }
        } catch {
            // Try the next file.
        }
    }

    // Last resort: derive a longitude from the UTC offset.
    const offsetHours = tz.get_offset(tz.find_interval(GLib.TimeType.UNIVERSAL,
        Math.floor(Date.now() / 1000))) / 3600;
    return {lat: 45, lon: Math.max(-180, Math.min(180, offsetHours * 15)), label: id || 'UTC'};
}
