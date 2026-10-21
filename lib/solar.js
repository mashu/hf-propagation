// Solar geometry: sub-solar point, elevation/azimuth, sunrise/sunset and
// grey-line (twilight) windows. Accuracy is well within a minute, which is
// plenty for propagation work.

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;

/** Sun elevation (degrees) that defines sunrise/sunset (upper limb + refraction). */
export const SUNRISE_ELEVATION = -0.833;

/** Grey line: from civil dusk/dawn (-6°) to a few degrees above the horizon. */
export const GREYLINE_LOW = -6;
export const GREYLINE_HIGH = 3;

function normDeg(deg) {
    return ((deg % 360) + 360) % 360;
}

/**
 * @param {number} lon - longitude in degrees
 * @returns {number} longitude wrapped to [-180, 180)
 */
export function wrapLon(lon) {
    return normDeg(lon + 180) - 180;
}

/**
 * Position of the sun for an instant.
 *
 * @param {Date|number} date - instant
 * @returns {{declination: number, subLon: number}} degrees
 */
export function sunPosition(date) {
    const ms = typeof date === 'number' ? date : date.getTime();
    const n = ms / 86400000 + 2440587.5 - 2451545.0;
    const L = normDeg(280.460 + 0.9856474 * n);
    const g = normDeg(357.528 + 0.9856003 * n) * RAD;
    const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
    const eps = (23.439 - 0.0000004 * n) * RAD;

    const declination = Math.asin(Math.sin(eps) * Math.sin(lambda)) * DEG;
    const ra = normDeg(Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) * DEG);

    // Equation of time in degrees (apparent minus mean solar time).
    const eot = wrapLon(L - ra);
    const utcHours = (((ms / HOUR) % 24) + 24) % 24;
    const subLon = wrapLon(-15 * (utcHours - 12) - eot);

    return {declination, subLon};
}

/**
 * Cosine of the solar zenith angle at a location.
 *
 * @param {number} lat - degrees
 * @param {number} lon - degrees
 * @param {{declination: number, subLon: number}} sun - from sunPosition()
 * @returns {number}
 */
export function cosZenith(lat, lon, sun) {
    const phi = lat * RAD;
    const dec = sun.declination * RAD;
    const h = (lon - sun.subLon) * RAD;
    return Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h);
}

/**
 * @param {number} lat - degrees
 * @param {number} lon - degrees
 * @param {Date|number} date - instant
 * @returns {number} solar elevation in degrees
 */
export function elevation(lat, lon, date) {
    const c = cosZenith(lat, lon, sunPosition(date));
    return Math.asin(Math.max(-1, Math.min(1, c))) * DEG;
}

/**
 * @param {number} lat - degrees
 * @param {number} lon - degrees
 * @param {Date|number} date - instant
 * @returns {number} solar azimuth in degrees, clockwise from north
 */
export function azimuth(lat, lon, date) {
    const sun = sunPosition(date);
    const phi = lat * RAD;
    const dec = sun.declination * RAD;
    const h = (lon - sun.subLon) * RAD;
    const az = Math.atan2(-Math.cos(dec) * Math.sin(h),
        Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(h));
    return normDeg(az * DEG);
}

/**
 * Find the instants where the solar elevation crosses a threshold.
 *
 * @param {number} lat - degrees
 * @param {number} lon - degrees
 * @param {number} fromMs - start of the search window (ms since epoch)
 * @param {number} toMs - end of the search window
 * @param {number} threshold - elevation in degrees
 * @returns {Array<{time: number, rising: boolean}>}
 */
export function crossings(lat, lon, fromMs, toMs, threshold) {
    const step = 4 * MINUTE;
    const result = [];
    let prevT = fromMs;
    let prev = elevation(lat, lon, prevT) - threshold;
    for (let t = fromMs + step; t <= toMs; t += step) {
        const cur = elevation(lat, lon, t) - threshold;
        if ((prev < 0) !== (cur < 0)) {
            // Refine with a few bisection steps.
            let a = prevT, b = t, fa = prev;
            for (let i = 0; i < 12; i++) {
                const m = (a + b) / 2;
                const fm = elevation(lat, lon, m) - threshold;
                if ((fa < 0) === (fm < 0)) {
                    a = m;
                    fa = fm;
                } else {
                    b = m;
                }
            }
            result.push({time: Math.round((a + b) / 2), rising: cur > prev});
        }
        prevT = t;
        prev = cur;
    }
    return result;
}

/**
 * Everything the UI needs to know about the sun at the station.
 *
 * @param {number} lat - degrees
 * @param {number} lon - degrees
 * @param {number} nowMs - current instant
 * @returns {object}
 */
export function sunReport(lat, lon, nowMs) {
    const from = nowMs - 24 * HOUR;
    const to = nowMs + 36 * HOUR;

    const horizon = crossings(lat, lon, from, to, SUNRISE_ELEVATION);
    const sunrises = horizon.filter(c => c.rising).map(c => c.time);
    const sunsets = horizon.filter(c => !c.rising).map(c => c.time);

    // Sunrise/sunset of the current local day, falling back to the next one.
    const nextOrRecent = list => {
        const upcoming = list.find(t => t >= nowMs);
        const recent = [...list].reverse().find(t => t < nowMs);
        if (recent !== undefined && nowMs - recent < 12 * HOUR)
            return recent;
        return upcoming ?? recent ?? null;
    };

    const elev = elevation(lat, lon, nowMs);
    const az = azimuth(lat, lon, nowMs);

    // Grey line windows: periods where elevation is within [LOW, HIGH].
    const lows = crossings(lat, lon, from, to, GREYLINE_LOW);
    const highs = crossings(lat, lon, from, to, GREYLINE_HIGH);
    const windows = [];
    for (const low of lows) {
        if (low.rising) {
            // Dawn: elevation rises through LOW, then through HIGH.
            const end = highs.find(h => h.rising && h.time > low.time);
            if (end && end.time - low.time < 6 * HOUR)
                windows.push({kind: 'dawn', start: low.time, end: end.time});
        } else {
            // Dusk: elevation falls through HIGH, then through LOW.
            const start = [...highs].reverse().find(h => !h.rising && h.time < low.time);
            if (start && low.time - start.time < 6 * HOUR)
                windows.push({kind: 'dusk', start: start.time, end: low.time});
        }
    }
    windows.sort((a, b) => a.start - b.start);

    const activeGreyline = windows.find(w => w.start <= nowMs && nowMs <= w.end) ?? null;
    const nextGreyline = windows.filter(w => w.start > nowMs);

    let dayLengthMs = null;
    const sr = nextOrRecent(sunrises);
    if (sr !== null) {
        const ss = sunsets.find(t => t > sr);
        if (ss !== undefined)
            dayLengthMs = ss - sr;
    }

    // Solar noon: maximum elevation, found from the sub-solar longitude.
    let noon = null;
    for (let t = nowMs - 12 * HOUR; t < nowMs + 12 * HOUR; t += 10 * MINUTE) {
        const h = wrapLon(lon - sunPosition(t).subLon);
        const h2 = wrapLon(lon - sunPosition(t + 10 * MINUTE).subLon);
        if (h <= 0 && h2 > 0) {
            noon = t + 10 * MINUTE * (-h / (h2 - h));
            break;
        }
    }

    let polar = null;
    if (sunrises.length === 0 && sunsets.length === 0)
        polar = elev > 0 ? 'day' : 'night';

    return {
        elevation: elev,
        azimuth: az,
        sunrise: sr,
        sunset: nextOrRecent(sunsets),
        nextSunrise: sunrises.find(t => t >= nowMs) ?? null,
        nextSunset: sunsets.find(t => t >= nowMs) ?? null,
        noon,
        dayLengthMs,
        polar,
        greyline: {
            active: activeGreyline,
            next: nextGreyline,
            windows,
        },
    };
}

/**
 * Classify a sun elevation as day, grey line or night.
 *
 * @param {number} elev - degrees
 * @returns {'day'|'greyline'|'night'}
 */
export function phaseForElevation(elev) {
    if (elev > GREYLINE_HIGH)
        return 'day';
    if (elev >= GREYLINE_LOW)
        return 'greyline';
    return 'night';
}
