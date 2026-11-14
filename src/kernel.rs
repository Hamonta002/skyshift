#![no_std]

use core::slice;

const RAD: f64 = core::f64::consts::PI / 180.0;

#[inline(always)]
fn sip(coefficients: &[f64], u: f64, v: f64) -> f64 {
    coefficients[0] + coefficients[1] * u + coefficients[2] * v
        + coefficients[3] * u * u + coefficients[4] * u * v + coefficients[5] * v * v
        + coefficients[6] * u * u * u + coefficients[7] * u * u * v
        + coefficients[8] * u * v * v + coefficients[9] * v * v * v
}

fn select(values: &mut [f32], rank: usize) -> f32 {
    let (mut low, mut high) = (0isize, values.len() as isize - 1);
    let rank = rank as isize;
    while low < high {
        let pivot = values[((low + high) / 2) as usize];
        let (mut i, mut j) = (low, high);
        while i <= j {
            while i <= high && values[i as usize] < pivot {
                i += 1;
            }
            while j >= low && values[j as usize] > pivot {
                j -= 1;
            }
            if i <= j {
                values.swap(i as usize, j as usize);
                i += 1;
                j -= 1;
            }
        }
        if rank <= j {
            high = j;
        } else if rank >= i {
            low = i;
        } else {
            break;
        }
    }
    values[rank as usize]
}

fn median(values: &mut [f32]) -> f64 {
    let middle = values.len() / 2;
    let upper = select(values, middle) as f64;
    if values.len() % 2 != 0 {
        upper
    } else {
        (upper + select(values, middle - 1) as f64) * 0.5
    }
}

// The worker supplies separate, aligned regions of WASM memory for all
// buffers. Only these entry points handle raw pointers.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn align(
    sky: *const f64,
    wcs: *const f64,
    pixels: *const f32,
    output: *mut f32,
    scratch: *mut f32,
    count: u32,
    size: u32,
    x0: f64,
    y0: f64,
) -> u32 {
    let count = count as usize;
    let size = size as usize;
    let sky = unsafe { slice::from_raw_parts(sky, count * 3) };
    let wcs = unsafe { slice::from_raw_parts(wcs, 55) };
    let pixels = unsafe { slice::from_raw_parts(pixels, size * size) };
    let output = unsafe { slice::from_raw_parts_mut(output, count) };
    let scratch = unsafe { slice::from_raw_parts_mut(scratch, count) };
    let mut finite = 0;

    for (pixel, direction) in output.iter_mut().zip(sky.chunks_exact(3)) {
        let (sx, sy, sz) = (direction[0], direction[1], direction[2]);
        let projection = sx * wcs[0] + sy * wcs[1] + sz * wcs[2];
        let mut value = f32::NAN;
        if projection > 0.0 {
            let xi = (sx * wcs[3] + sy * wcs[4] + sz * wcs[5]) / projection / RAD;
            let eta = (sx * wcs[6] + sy * wcs[7] + sz * wcs[8]) / projection / RAD;
            let u0 = wcs[9] * xi + wcs[10] * eta;
            let v0 = wcs[11] * xi + wcs[12] * eta;
            let (mut u, mut v) = (u0 + sip(&wcs[35..45], u0, v0), v0 + sip(&wcs[45..55], u0, v0));
            for _ in 0..2 {
                let next_u = u0 - sip(&wcs[15..25], u, v);
                v = v0 - sip(&wcs[25..35], u, v);
                u = next_u;
            }
            let (bx, by) = (u + wcs[13] - x0, v + wcs[14] - y0);
            if bx >= 0.0 && by >= 0.0 && bx < (size - 1) as f64 && by < (size - 1) as f64 {
                let (x, y) = (bx as usize, by as usize);
                let (tx, ty) = (bx - x as f64, by - y as f64);
                let i = y * size + x;
                value = (pixels[i] as f64 * (1.0 - tx) * (1.0 - ty)
                    + pixels[i + 1] as f64 * tx * (1.0 - ty)
                    + pixels[i + size] as f64 * (1.0 - tx) * ty
                    + pixels[i + size + 1] as f64 * tx * ty) as f32;
            }
        }
        *pixel = value;
        if value.is_finite() {
            scratch[finite] = value;
            finite += 1;
        }
    }
    if finite * 2 < count {
        return 0;
    }
    let background = median(&mut scratch[..finite]);
    for value in output {
        *value = (*value as f64 - background) as f32;
    }
    1
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn stack(
    frames: *const f32,
    output: *mut f32,
    scratch: *mut f32,
    length: u32,
    frame_count: u32,
) {
    let length = length as usize;
    let frame_count = frame_count as usize;
    let frames = unsafe { slice::from_raw_parts(frames, length * frame_count) };
    let output = unsafe { slice::from_raw_parts_mut(output, length) };
    let scratch = unsafe { slice::from_raw_parts_mut(scratch, frame_count) };
    for (i, output) in output.iter_mut().enumerate() {
        let mut count = 0;
        for frame in frames.chunks_exact(length) {
            let value = frame[i];
            if value.is_finite() {
                scratch[count] = value;
                count += 1;
            }
        }
        *output = if count == 0 {
            f32::NAN
        } else {
            median(&mut scratch[..count]) as f32
        };
    }
}
