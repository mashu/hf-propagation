// Land mask for the dot-matrix world map.
// Generated from Natural Earth 1:50m land polygons (public domain),
// rasterised on a 3 degree grid. Each row is a hex string of 120 bits,
// west (-180) to east (+180). Rows run from 81N down to 60S.

export const STEP = 3;
export const LAT_TOP = 81;
export const LAT_BOTTOM = -60;
export const COLUMNS = 120;

export const ROWS = [
    '0000004ffffffc00f000001e000000',
    '00000f3fc7fffc004000a01fc02000',
    '00003ebfe07ff800000311fff61000',
    '03f057dff83ff8003c023fffffffc0',
    'e7ffffff9e3fc0007fffffffffffff',
    '6fffffff1c3e0e01efffffffffffff',
    '07fffff8381c0003dffffffffffffe',
    '0383fff83e000023cffffffffff060',
    '0001ffff3f0000719fffffffffc0c0',
    '00007fffffc00057fffffffffff080',
    '00003fffffc0001ffffffffffff000',
    '00003fffff00001fffffffffffc000',
    '00003ffffa00007ffc77ffffff9000',
    '00003ffff00000787ffbfffffe0000',
    '00001fffe000007097fbfffff22000',
    '00000fffe000003f00fffffff2c000',
    '000007ff8000007ffffffffff80000',
    '000003f0800000fffff7fffff80000',
    '000002f0000001fffff9fffff00000',
    '00000070400003ffff7f1fffe00000',
    '00000076380003ffffff0f9f800000',
    '0000001e000003ffffbc0f1f080000',
    '00000003000003fffff006078c0000',
    '000000011e0001fffff80603040000',
    '00000000bf8000fffff80204040000',
    '000000003fe00053fff0000e300000',
    '000000007fe00001ffe00006f00000',
    '000000007ff80001ffc00006e8a000',
    '000000007fff0000ff800002187800',
    '000000007fff8000ff800001e03800',
    '000000003fff0000ffc00000000400',
    '000000003ffe0000ffc8000001d000',
    '000000001ffe0000ff98000007f800',
    '000000000ffe0000ff1800000ff800',
    '000000000ffc0000ff3000003ffc00',
    '000000000ff000007e1000003ffe00',
    '000000000ff000007e0000003ffe00',
    '000000000fe000003c0000003ffe00',
    '000000000fc0000030000000307e00',
    '000000001f80000000000000003c02',
    '000000001e00000000000000000002',
    '000000001e0000000000000000000c',
    '000000001c00000000000000000008',
    '000000001c00000000000000000000',
    '000000001800000000000000000000',
    '000000000400000000000000000000',
    '000000000000000000000000000000',
];

/**
 * Iterate over all land cells.
 *
 * @param {Function} callback - called with (lat, lon) of each land cell centre
 */
export function forEachLandCell(callback) {
    for (let r = 0; r < ROWS.length; r++) {
        const row = ROWS[r];
        const lat = LAT_TOP - (r + 0.5) * STEP;
        for (let c = 0; c < COLUMNS; c++) {
            const nibble = parseInt(row[c >> 2], 16);
            if (nibble & (8 >> (c & 3)))
                callback(lat, -180 + (c + 0.5) * STEP);
        }
    }
}
