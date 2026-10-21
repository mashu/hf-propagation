// A compact, empirical HF propagation model for the station's location.
//
// It is intentionally simple – a few dozen lines of well-known relations –
// but it reacts to the things that matter on the air:
//
//  * F2 critical frequency from the effective sunspot number (derived from
//    SFI), solar zenith angle with a realistic sunrise build-up and slow
//    post-sunset decay, season (winter anomaly), latitude and storms (Kp).
//  * MUF(3000)F2 = foF2 × M(3000), calibrated against nearby ionosondes
//    (KC2G / GIRO) when available.
//  * D-layer absorption (zenith angle + solar activity), X-ray flare
//    absorption (NOAA D-RAP HAF relation), polar-cap and auroral absorption.
//  * Noise floor from ITU-R P.372 man-made, galactic and atmospheric noise
//    plus geomagnetic noise reported by N0NBH.
//  * Sporadic-E climatology for 10/12/6 m with live N0NBH VHF reports.
//  * Blending with N0NBH's day/night band group conditions.

import * as Solar from './solar.js';
import {distanceKm} from './geo.js';

const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;

export const BANDS = [
    {id: '160m', freq: 1.85, group: '80m-40m'},
    {id: '80m', freq: 3.65, group: '80m-40m'},
    {id: '60m', freq: 5.36, group: '80m-40m'},
    {id: '40m', freq: 7.1, group: '80m-40m'},
    {id: '30m', freq: 10.12, group: '30m-20m'},
    {id: '20m', freq: 14.15, group: '30m-20m'},
    {id: '17m', freq: 18.1, group: '17m-15m'},
    {id: '15m', freq: 21.2, group: '17m-15m'},
    {id: '12m', freq: 24.94, group: '12m-10m'},
    {id: '10m', freq: 28.5, group: '12m-10m'},
    {id: '6m', freq: 50.15, group: null},
];

export const CONDITION_LABELS = {
    excellent: 'Excellent',
    good: 'Good',
    fair: 'Fair',
    poor: 'Poor',
    closed: 'Closed',
};

export const NOISE_ENVIRONMENTS = {
    'quiet': {label: 'Quiet rural', c: 53.6, d: 28.6},
    'rural': {label: 'Rural', c: 67.2, d: 27.7},
    'residential': {label: 'Residential', c: 72.5, d: 27.7},
    'city': {label: 'City', c: 76.8, d: 27.7},
};

const HAMQSL_SCORE = {good: 0.85, fair: 0.55, poor: 0.22};

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

/**
 * @param {number} score - 0..1
 * @returns {'excellent'|'good'|'fair'|'poor'|'closed'}
 */
export function conditionFor(score) {
    if (score >= 0.72)
        return 'excellent';
    if (score >= 0.52)
        return 'good';
    if (score >= 0.33)
        return 'fair';
    if (score >= 0.15)
        return 'poor';
    return 'closed';
}

/**
 * Effective sunspot number from the 10.7 cm solar flux
 * (SFI = 63.7 + 0.728 R + 0.00089 R²).
 *
 * @param {number} sfi - solar flux units
 * @returns {number|null}
 */
export function effectiveSsn(sfi) {
    if (!(sfi > 0))
        return null;
    const a = 0.00089, b = 0.728, c = 63.7 - sfi;
    return Math.max(0, (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a));
}

function dayOfYear(ms) {
    const d = new Date(ms);
    return (ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000;
}

function circularDiff(a, b, period) {
    const d = ((a - b) % period + period) % period;
    return d > period / 2 ? d - period : d;
}

/**
 * +1 deep in local winter, -1 in local summer, 0 near the equator.
 *
 * @param {number} lat - degrees
 * @param {number} ms - instant
 * @returns {number}
 */
function winterness(lat, ms) {
    const w = Math.cos(2 * Math.PI * (dayOfYear(ms) + 10) / 365.25);
    return w * (lat >= 0 ? 1 : -1) * clamp((Math.abs(lat) - 15) / 30, 0, 1);
}

function f2Params(ssn, lat, ms) {
    const R = clamp(ssn, 0, 220);
    let peak = 5.2 + 0.062 * R;
    let night = 2.3 + 0.024 * R;

    const w = winterness(lat, ms);
    peak *= 1 + 0.12 * w * clamp(R / 120, 0.2, 1);
    night *= 1 - 0.08 * w;

    const alat = Math.abs(lat);
    const crest = 1 + 0.12 * Math.exp(-(((alat - 15) / 10) ** 2));
    const polar = 1 - 0.18 * clamp((alat - 55) / 20, 0, 1);
    return {peak: peak * crest * polar, night: night * crest * polar};
}

function stormFactor(kp, lat) {
    if (!(kp > 4))
        return 1;
    const s = clamp((Math.abs(lat) - 25) / 35, 0.15, 1);
    return 1 - 0.07 * (kp - 4) * s;
}

/**
 * Simulate the F2 ionisation driver: rises about an hour after F-region
 * sunrise, decays over a few hours after sunset.
 *
 * @param {number} lat - degrees
 * @param {number} lon - degrees
 * @param {number} fromMs - first sample
 * @param {number} toMs - last sample
 * @param {number} stepMs - resolution
 * @returns {{from: number, step: number, x: number[], cz: number[]}}
 */
function simulateDriver(lat, lon, fromMs, toMs, stepMs) {
    const tauRise = HOUR;
    const tauDecay = 3.2 * HOUR;
    const warmup = 36 * HOUR;
    const xs = [], czs = [];
    let x = 0.35;
    for (let t = fromMs - warmup; t <= toMs + stepMs; t += stepMs) {
        const cz = Solar.cosZenith(lat, lon, Solar.sunPosition(t));
        // The F region (~300 km) is sunlit before ground sunrise.
        const target = cz > -0.1 ? Math.pow((cz + 0.1) / 1.1, 0.35) : 0;
        const tau = target > x ? tauRise : tauDecay;
        x += (target - x) * (1 - Math.exp(-stepMs / tau));
        if (t >= fromMs) {
            xs.push(x);
            czs.push(cz);
        }
    }
    return {from: fromMs, step: stepMs, x: xs, cz: czs};
}

function sampleDriver(drv, t) {
    const i = clamp(Math.round((t - drv.from) / drv.step), 0, drv.x.length - 1);
    return {x: drv.x[i], cz: drv.cz[i]};
}

function mufFromDriver(params, x, kp, lat) {
    const fof2 = (params.night + (params.peak - params.night) * x) * stormFactor(kp, lat);
    return {fof2, muf: fof2 * (2.9 + 0.35 * x)};
}

/**
 * Total one-hop absorption in dB.
 *
 * @param {number} f - MHz
 * @param {object} p - {cz, ssn, xrayFlux, protonFlux, kp, lat}
 * @returns {number}
 */
export function absorptionDb(f, p) {
    const cz = Math.max(0, p.cz);
    const czp = Math.pow(cz, 0.75);
    let a = 700 * (1 + 0.0037 * p.ssn) * (czp + 0.015) / ((f + 1.2) ** 2);

    // X-ray flares (NOAA D-RAP: HAF = 10 log10(flux) + 65 MHz at the sub-solar point).
    if (p.xrayFlux > 0) {
        const haf = Math.max(0, 10 * Math.log10(p.xrayFlux) + 65) * czp;
        if (haf > 0)
            a += 3 * (haf / f) ** 2;
    }

    const alat = Math.abs(p.lat);
    // Polar cap absorption during proton events.
    if (p.protonFlux >= 10 && alat >= 55)
        a += (3 + 6 * Math.log10(p.protonFlux / 10 + 1)) * (10 / f) ** 1.5 * clamp((alat - 55) / 10, 0, 1);

    // Auroral absorption during storms.
    if (p.kp >= 5 && alat >= 50)
        a += 1.5 * (p.kp - 4) * (10 / f) ** 1.5 * clamp((alat - 50) / 15, 0, 1);

    return a;
}

/**
 * Lowest usable frequency, here: where absorption drops below 10 dB.
 *
 * @param {object} p - see absorptionDb()
 * @returns {number} MHz
 */
export function lowestUsableFrequency(p) {
    let lo = 0.5, hi = 60;
    if (absorptionDb(lo, p) < 10)
        return lo;
    for (let i = 0; i < 30; i++) {
        const m = (lo + hi) / 2;
        if (absorptionDb(m, p) > 10)
            lo = m;
        else
            hi = m;
    }
    return hi;
}

/**
 * Noise floor in a 2.4 kHz SSB channel.
 *
 * @param {number} f - MHz
 * @param {string} env - key of NOISE_ENVIRONMENTS
 * @param {object} p - {night, summer, geomagS}
 * @returns {{dbm: number, s: number}}
 */
export function noiseFloor(f, env, p) {
    const e = NOISE_ENVIRONMENTS[env] ?? NOISE_ENVIRONMENTS.residential;
    const lf = Math.log10(f);
    const manMade = e.c - e.d * lf;
    const galactic = 52 - 23 * lf;
    const atmospheric = (p.night ? 76 : 50) + (p.summer ? 6 : 0) - 36 * lf;
    const fa = 10 * Math.log10(10 ** (manMade / 10) + 10 ** (galactic / 10) + 10 ** (atmospheric / 10));
    let dbm = fa - 140.2;
    if (p.geomagS > 0)
        dbm = 10 * Math.log10(10 ** (dbm / 10) + 10 ** ((-121 + 6 * (p.geomagS - 1)) / 10));
    return {dbm, s: 9 + (dbm + 73) / 6};
}

/**
 * @param {number} s - S-units (may exceed 9)
 * @returns {string}
 */
export function formatS(s) {
    if (s >= 9.8) {
        const over = Math.round(((s - 9) * 6) / 5) * 5;
        return over > 0 ? `S9+${over}` : 'S9';
    }
    return `S${clamp(Math.round(s), 0, 9)}`;
}

/**
 * Parse N0NBH's "S1-S2" style noise report.
 *
 * @param {string} text - signal noise text
 * @returns {number} highest S-unit mentioned, 0 if unknown
 */
export function parseSignalNoise(text) {
    const nums = [...String(text ?? '').matchAll(/S\s*(\d)/gi)].map(m => parseInt(m[1]));
    return nums.length ? Math.max(...nums) : 0;
}

function esProbability(lat, lon, ms) {
    const doy = dayOfYear(ms);
    const north = lat >= 0;
    const dSummer = circularDiff(doy, north ? 172 : 355, 365.25);
    const dWinter = circularDiff(doy, north ? 360 : 172, 365.25);
    let season = Math.exp(-((dSummer / 40) ** 2)) + 0.22 * Math.exp(-((dWinter / 14) ** 2));
    if (Math.abs(lat) < 20)
        season = Math.max(season, 0.35);
    if (Math.abs(lat) > 65)
        season *= 0.5;

    const h = (((ms / HOUR + lon / 15) % 24) + 24) % 24;
    const diurnal = 0.12 + 0.88 * Math.max(
        Math.exp(-(((h - 10.5) / 2.5) ** 2)),
        0.85 * Math.exp(-(((h - 18.5) / 2.2) ** 2)));
    return clamp(0.6 * season * diurnal, 0, 0.6);
}

function stationRegion(lat, lon) {
    if (lat >= 34 && lat <= 72 && lon >= -25 && lon <= 45)
        return 'europe';
    if (lat >= 15 && lat <= 72 && lon >= -170 && lon <= -50)
        return 'north_america';
    return null;
}

function vhfEsReport(vhf, region) {
    if (!vhf || !region)
        return 0;
    const open = loc => {
        const p = vhf.find(v => /e-?skip/i.test(v.name) && v.location === loc);
        return p && !/closed/i.test(p.value);
    };
    if (region === 'north_america')
        return open('north_america') ? 1 : 0;
    // A 2 m or 4 m opening implies a higher Es MUF than a 6 m one.
    if (open('europe'))
        return 1;
    if (open('europe_4m'))
        return 0.9;
    return open('europe_6m') ? 0.85 : 0;
}

function vhfAuroraReport(vhf, lat) {
    if (!vhf || Math.abs(lat) < 48)
        return 0;
    const p = vhf.find(v => /aurora/i.test(v.name));
    return p && !/closed/i.test(p.value) ? 1 : 0;
}

function makeKp(kpNow, forecast, now) {
    const fc = (forecast ?? []).slice().sort((a, b) => a.time - b.time);
    const base = kpNow ?? 2;
    return t => {
        if (t - now < 3 * HOUR || fc.length === 0)
            return base;
        let v = null;
        for (const f of fc) {
            if (f.time <= t)
                v = f.kp;
            else
                break;
        }
        return v ?? base;
    };
}

function calibrate(input, ssn, kpAt, now) {
    const {lat, lon} = input;
    const candidates = (input.ionosondes ?? [])
        .filter(s => s.time && now - s.time < 3 * HOUR && s.time - now < HOUR)
        .map(s => ({...s, distance: distanceKm(lat, lon, s.lat, s.lon)}))
        .filter(s => s.distance < 2500)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 3);

    if (candidates.length === 0)
        return {ratio: 1, stations: []};

    let wsum = 0, rsum = 0;
    for (const s of candidates) {
        const drv = simulateDriver(s.lat, s.lon, s.time, s.time, 10 * MINUTE);
        const {x} = sampleDriver(drv, s.time);
        const {muf} = mufFromDriver(f2Params(ssn, s.lat, s.time), x, kpAt(s.time), s.lat);
        s.ratio = clamp(s.mufd / muf, 0.5, 1.9);
        const w = 1 / (1 + (s.distance / 600) ** 2) / (1 + (now - s.time) / HOUR);
        wsum += w;
        rsum += w * s.ratio;
    }
    return {ratio: rsum / wsum, stations: candidates};
}

function scoreBand(band, h, ctx) {
    const f = band.freq;
    const r = f / h.muf;
    let m;
    if (r <= 0.85)
        m = 1;
    else if (r <= 1)
        m = 1 - ((r - 0.85) / 0.15) * 0.35;
    else if (r <= 1.15)
        m = 0.65 - ((r - 1) / 0.15) * 0.55;
    else
        m = Math.max(0.02, 0.1 - (r - 1.15));

    const absorption = absorptionDb(f, {...ctx.absorptionParams, cz: h.cz, kp: h.kp});
    const a = 1 / (1 + (absorption / 12) ** 2);

    const noise = noiseFloor(f, ctx.noiseEnv, {
        night: h.elevation < Solar.GREYLINE_LOW,
        summer: ctx.summer,
        geomagS: ctx.geomagS,
    });
    const n = 1 - clamp((noise.s - 3) / 12, 0, 0.4);

    const kpPenalty = clamp((h.kp - 3) * 0.07 * clamp(Math.abs(ctx.lat) / 50, 0.4, 1.4), 0, 0.7);
    const g = 1 - kpPenalty;

    let score = m * a * n * g;

    // Sporadic E on the higher bands.
    if (f >= 18) {
        let weight = 0.75;
        if (f >= 50)
            weight = 1;
        else if (f >= 24)
            weight = 0.9;
        const es = h.es * weight * n * (1 - kpPenalty * 0.3);
        score = Math.max(score, es);
    }

    // Aurora scatter (CW / SSB with the typical buzzy signals) for high-latitude stations.
    if (h.aurora > 0 && f >= 28)
        score = Math.max(score, h.aurora * (f >= 50 ? 0.5 : 0.36));

    // Blend with N0NBH's day/night band group conditions.
    const groups = ctx.hamqslBands;
    if (band.group && groups?.[band.group]) {
        const key = h.elevation > Solar.GREYLINE_LOW ? 'day' : 'night';
        const ref = HAMQSL_SCORE[String(groups[band.group][key] ?? '').toLowerCase()];
        if (ref !== undefined) {
            const weight = band.id === '160m' ? 0.12 : 0.28;
            score = (1 - weight) * score + weight * ref;
        }
    }

    return {score: clamp(score, 0, 1), absorption, noise};
}

/**
 * Pick the best contiguous operating window from hourly scores.
 *
 * @param {number[]} scores - hourly scores
 * @returns {{from: number, to: number, peak: number}|null} indices, `to` exclusive
 */
export function bestWindow(scores) {
    const peak = Math.max(...scores);
    if (peak < 0.33)
        return null;
    const thr = Math.max(0.33, peak - 0.15);
    let best = null;
    let i = 0;
    while (i < scores.length) {
        if (scores[i] >= thr) {
            let j = i, sum = 0;
            while (j < scores.length && scores[j] >= thr) {
                sum += scores[j];
                j++;
            }
            if (!best || sum > best.sum)
                best = {from: i, to: j, sum};
            i = j;
        } else {
            i++;
        }
    }
    return {from: best.from, to: best.to, peak};
}

/**
 * Build the full picture: current ionosphere, per-band conditions and a
 * 24-hour outlook.
 *
 * @param {object} input - see extension.js for the fields
 * @returns {object}
 */
export function buildForecast(input) {
    const now = input.now ?? Date.now();
    const {lat, lon} = input;

    const ssnFromSfi = effectiveSsn(input.sfi);
    const ssn = ssnFromSfi ?? input.ssn ?? 60;
    const kpAt = makeKp(input.kpNow, input.kpForecast, now);

    const hourStart = Math.floor(now / HOUR) * HOUR;
    const drv = simulateDriver(lat, lon, now - HOUR, hourStart + 25 * HOUR, 10 * MINUTE);
    const calib = input.useIonosondes === false
        ? {ratio: 1, stations: []}
        : calibrate(input, ssn, kpAt, now);

    const absorptionParams = {
        ssn,
        xrayFlux: input.xrayFlux ?? 0,
        protonFlux: input.protonFlux ?? 0,
        lat,
    };

    const region = stationRegion(lat, lon);
    const esReport = vhfEsReport(input.vhf, region);
    const auroraReport = vhfAuroraReport(input.vhf, lat);

    const ctx = {
        lat,
        noiseEnv: input.noiseEnv ?? 'residential',
        summer: winterness(lat, now) < -0.3,
        geomagS: parseSignalNoise(input.signalNoise),
        hamqslBands: input.hamqslBands,
        absorptionParams,
    };

    const hours = [];
    for (let i = 0; i < 24; i++) {
        const start = hourStart + i * HOUR;
        const t = i === 0 ? now : start + 30 * MINUTE;
        const {x, cz} = sampleDriver(drv, t);
        const kp = kpAt(t);
        const params = f2Params(ssn, lat, t);
        const base = mufFromDriver(params, x, kp, lat);
        const corr = 1 + (calib.ratio - 1) * Math.exp(-Math.max(0, t - now) / (12 * HOUR));
        const elevationDeg = Math.asin(clamp(cz, -1, 1)) * 180 / Math.PI;

        let es = esProbability(lat, lon, t);
        if (esReport > 0)
            es = Math.max(es, 0.8 * esReport * Math.exp(-(t - now) / (2 * HOUR)));

        const h = {
            start,
            time: t,
            cz,
            kp,
            elevation: elevationDeg,
            phase: Solar.phaseForElevation(elevationDeg),
            fof2: base.fof2 * corr,
            muf: base.muf * corr,
            es,
            aurora: auroraReport * Math.exp(-(t - now) / (3 * HOUR)),
        };
        h.luf = lowestUsableFrequency({...absorptionParams, cz, kp});
        h.bands = BANDS.map(b => scoreBand(b, h, ctx));
        hours.push(h);
    }

    const current = hours[0];
    const bands = BANDS.map((b, i) => {
        const hourly = hours.map(h => h.bands[i].score);
        const win = bestWindow(hourly);
        return {
            ...b,
            score: hourly[0],
            condition: conditionFor(hourly[0]),
            hourly,
            best: win ? {
                ...win,
                start: hours[win.from].start,
                end: hours[win.to - 1].start + HOUR,
                allDay: win.to - win.from >= 24,
                startsNow: win.from === 0,
            } : null,
            noise: current.bands[i].noise,
            absorption: current.bands[i].absorption,
        };
    });

    // Overall index: the average of the four best HF bands right now.
    const hf = bands.filter(b => b.freq > 3 && b.freq < 30).map(b => b.score).sort((a, b) => b - a);
    const overall = hf.slice(0, 4).reduce((s, v) => s + v, 0) / 4;

    const absorption10 = absorptionDb(10, {...absorptionParams, cz: current.cz, kp: current.kp});
    let absorptionLevel;
    if (absorption10 < 3)
        absorptionLevel = 'Low';
    else if (absorption10 < 7)
        absorptionLevel = 'Moderate';
    else if (absorption10 < 14)
        absorptionLevel = 'High';
    else
        absorptionLevel = 'Severe';

    return {
        time: now,
        hourStart,
        ssn,
        ssnFromSfi,
        muf: current.muf,
        fof2: current.fof2,
        luf: current.luf,
        absorption10,
        absorptionLevel,
        calibration: calib,
        es: current.es,
        esReport,
        region,
        hours,
        bands,
        overall: {score: overall, condition: conditionFor(overall)},
    };
}
