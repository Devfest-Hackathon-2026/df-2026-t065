/*
 * _notice: SYNTHETIC TEST DATA — programmatically generated JPEGs with EXIF APP1 metadata.
 * Asymmetric crop boundary pattern + quadrant background for Fault E (±1px shift) detection.
 * No real menu photos or personal data are used.
 */

export const EXPECTED_UPRIGHT_WIDTH = 100;
export const EXPECTED_UPRIGHT_HEIGHT = 160;

export const EXPECTED_CROP_X = 20;
export const EXPECTED_CROP_Y = 24;
export const EXPECTED_CROP_WIDTH = 60;
export const EXPECTED_CROP_HEIGHT = 80;

export const ORIENTATION_CONFIGS = {
  1: { w: 100, h: 160, name: "Normal (0°)" },
  2: { w: 100, h: 160, name: "Mirror horizontal" },
  3: { w: 100, h: 160, name: "Rotate 180°" },
  4: { w: 100, h: 160, name: "Mirror vertical" },
  5: { w: 160, h: 100, name: "Transpose (Mirror horiz + 270° CW)" },
  6: { w: 160, h: 100, name: "Rotate 90° CW" },
  7: { w: 160, h: 100, name: "Transverse (Mirror horiz + 90° CW)" },
  8: { w: 160, h: 100, name: "Rotate 270° CW" },
};

export const COLOR_RGB = {
  red: [220, 30, 30],
  green: [30, 180, 60],
  blue: [40, 70, 210],
  yellow: [230, 190, 30],
};

export function isRed([r, g, b]) {
  return r > 170 && g < 100 && b < 100;
}

export function isGreen([r, g, b]) {
  return r < 100 && g > 130 && b < 100;
}

export function isBlue([r, g, b]) {
  return r < 100 && g < 100 && b > 150;
}

export function isYellow([r, g, b]) {
  return r > 170 && g > 130 && b < 100;
}

export function assertUprightQuadrants(tl, tr, bl, br, label = "") {
  if (!isRed(tl)) throw new Error(`${label}Top-Left pixel must be RED, got rgb(${tl.join(",")})`);
  if (!isGreen(tr)) throw new Error(`${label}Top-Right pixel must be GREEN, got rgb(${tr.join(",")})`);
  if (!isBlue(bl)) throw new Error(`${label}Bottom-Left pixel must be BLUE, got rgb(${bl.join(",")})`);
  if (!isYellow(br)) throw new Error(`${label}Bottom-Right pixel must be YELLOW, got rgb(${br.join(",")})`);
}

/**
 * Asserts all 4 edges, 4 corners, and center pixel of a 60x80 crop result.
 * Sensitive to ±1px shifts in X and Y (Fault E).
 */
export function assertCropBoundaryPixels(crop, label = "") {
  const { leftEdgeMid, rightEdgeMid, topEdgeMid, bottomEdgeMid, center, topLeft, topRight, bottomLeft, bottomRight } = crop;

  // Left edge mid (x=0, y=40): Magenta line [~154, 80, 130]
  // Shift X+1 -> White interior [249, 231, 247] (G rises to >200)
  // Shift X-1 -> Red outer [181, 40, 83] (G drops to <50)
  if (leftEdgeMid[0] < 135 || leftEdgeMid[0] > 175 || leftEdgeMid[1] < 60 || leftEdgeMid[1] > 100 || leftEdgeMid[2] < 110 || leftEdgeMid[2] > 150) {
    throw new Error(`${label}Left edge pixel must be Magenta border [~154, 80, 130], got rgb(${leftEdgeMid.join(",")})`);
  }

  // Right edge mid (x=59, y=40): Cyan line [~110, 188, 175]
  // Shift X+1 -> Green outer [42, 164, 103] (R drops to ~42)
  // Shift X-1 -> White interior [216, 250, 251] (R rises to >200)
  if (rightEdgeMid[0] < 90 || rightEdgeMid[0] > 130 || rightEdgeMid[1] < 170 || rightEdgeMid[1] > 205 || rightEdgeMid[2] < 155 || rightEdgeMid[2] > 195) {
    throw new Error(`${label}Right edge pixel must be Cyan border [~110, 188, 175], got rgb(${rightEdgeMid.join(",")})`);
  }

  // Top edge mid (x=30, y=0): Dark Violet line [~88, 63, 118]
  // Shift Y+1 -> White interior [251, 239, 249] (R rises to >230)
  // Shift Y-1 -> Blue outer [71, 62, 169] (B rises to ~169)
  if (topEdgeMid[0] < 70 || topEdgeMid[0] > 105 || topEdgeMid[1] < 45 || topEdgeMid[1] > 80 || topEdgeMid[2] < 100 || topEdgeMid[2] > 135) {
    throw new Error(`${label}Top edge pixel must be Dark Violet border [~88, 63, 118], got rgb(${topEdgeMid.join(",")})`);
  }

  // Bottom edge mid (x=30, y=79): Orange line [~173, 147, 90]
  // Shift Y+1 -> Yellow outer [229, 182, 76] (R rises to ~229, G rises to ~182)
  // Shift Y-1 -> White interior [250, 248, 223] (B rises to >200)
  if (bottomEdgeMid[0] < 155 || bottomEdgeMid[0] > 190 || bottomEdgeMid[1] < 130 || bottomEdgeMid[1] > 165 || bottomEdgeMid[2] < 70 || bottomEdgeMid[2] > 110) {
    throw new Error(`${label}Bottom edge pixel must be Orange border [~173, 147, 90], got rgb(${bottomEdgeMid.join(",")})`);
  }

  // Center (x=30, y=40): White interior [255, 255, 255]
  if (center[0] < 240 || center[1] < 240 || center[2] < 240) {
    throw new Error(`${label}Center pixel must be White interior [>240, >240, >240], got rgb(${center.join(",")})`);
  }

  // Corners
  if (topLeft[0] < 145 || topLeft[0] > 185 || topLeft[1] < 50 || topLeft[1] > 85 || topLeft[2] < 145 || topLeft[2] > 185) {
    throw new Error(`${label}Top-Left corner pixel expected [~164, 67, 165], got rgb(${topLeft.join(",")})`);
  }
  if (topRight[0] < 105 || topRight[0] > 140 || topRight[1] < 160 || topRight[1] > 195 || topRight[2] < 185 || topRight[2] > 220) {
    throw new Error(`${label}Top-Right corner pixel expected [~121, 178, 201], got rgb(${topRight.join(",")})`);
  }
  if (bottomLeft[0] < 135 || bottomLeft[0] > 175 || bottomLeft[1] < 65 || bottomLeft[1] > 100 || bottomLeft[2] < 95 || bottomLeft[2] > 135) {
    throw new Error(`${label}Bottom-Left corner pixel expected [~156, 82, 115], got rgb(${bottomLeft.join(",")})`);
  }
  if (bottomRight[0] < 135 || bottomRight[0] > 175 || bottomRight[1] < 155 || bottomRight[1] > 195 || bottomRight[2] < 95 || bottomRight[2] > 135) {
    throw new Error(`${label}Bottom-Right corner pixel expected [~151, 178, 120], got rgb(${bottomRight.join(",")})`);
  }
}

/**
 * Generates synthetic JPEG buffers with real EXIF APP1 Orientation tags (1..8)
 * using the browser's Canvas JPEG encoder inside the given page.
 *
 * The raw canvas pattern is calculated per orientation via the inverse orientation mapping
 * so that when decoded in upright space:
 * - Upright dimensions are 100x160.
 * - 4 corners (10, 10), (90, 10), (10, 150), (90, 150) match Red, Green, Blue, Yellow quadrants.
 * - Non-zero crop region at x=20, y=24, w=60, h=80 has 1px asymmetric colored borders
 *   (Magenta left, Cyan right, Violet top, Orange bottom) and white interior, surrounded
 *   by high-contrast outer bands.
 */
export async function generateSyntheticExifJpegs(page) {
  const base64Map = await page.eval(`(async () => {
    const W = ${EXPECTED_UPRIGHT_WIDTH};
    const H = ${EXPECTED_UPRIGHT_HEIGHT};
    const crop = {
      x: ${EXPECTED_CROP_X},
      y: ${EXPECTED_CROP_Y},
      width: ${EXPECTED_CROP_WIDTH},
      height: ${EXPECTED_CROP_HEIGHT},
    };

    function uprightToRaw(ux, uy, o) {
      const isRot = o >= 5;
      const rw = isRot ? 160 : 100;
      const rh = isRot ? 100 : 160;
      let rx, ry;
      switch (o) {
        case 1: rx = ux; ry = uy; break;
        case 2: rx = rw - 1 - ux; ry = uy; break;
        case 3: rx = rw - 1 - ux; ry = rh - 1 - uy; break;
        case 4: rx = ux; ry = rh - 1 - uy; break;
        case 5: rx = uy; ry = ux; break;
        case 6: rx = uy; ry = rh - 1 - ux; break;
        case 7: rx = rw - 1 - uy; ry = rh - 1 - ux; break;
        case 8: rx = rw - 1 - uy; ry = ux; break;
      }
      return { rx: Math.round(rx), ry: Math.round(ry) };
    }

    const map = {};

    for (let orientation = 1; orientation <= 8; orientation++) {
      const isRot = orientation >= 5;
      const rw = isRot ? 160 : 100;
      const rh = isRot ? 100 : 160;

      const canvas = document.createElement("canvas");
      canvas.width = rw;
      canvas.height = rh;
      const ctx = canvas.getContext("2d");
      const imgData = ctx.createImageData(rw, rh);
      const data = imgData.data;

      for (let uy = 0; uy < H; uy++) {
        for (let ux = 0; ux < W; ux++) {
          let r = 255, g = 255, b = 255;
          if (ux < crop.x) {
            if (uy >= 80) { r = 40; g = 70; b = 210; } // BL: Blue
            else { r = 220; g = 30; b = 30; }         // TL: Red
          } else if (ux >= crop.x + crop.width) {
            if (uy >= 80) { r = 230; g = 190; b = 30; } // BR: Yellow
            else { r = 30; g = 180; b = 60; }          // TR: Green
          } else if (uy < crop.y) {
            r = 40; g = 70; b = 210;                   // Top outer: Blue
          } else if (uy >= crop.y + crop.height) {
            r = 230; g = 190; b = 30;                  // Bottom outer: Yellow
          } else {
            if (ux === crop.x) {
              r = 220; g = 30; b = 220; // Left border: Magenta
            } else if (ux === crop.x + crop.width - 1) {
              r = 30; g = 220; b = 220; // Right border: Cyan
            } else if (uy === crop.y) {
              r = 130; g = 30; b = 180; // Top border: Dark Violet
            } else if (uy === crop.y + crop.height - 1) {
              r = 230; g = 130; b = 30; // Bottom border: Orange
            } else {
              r = 255; g = 255; b = 255; // Interior: White
            }
          }
          const { rx, ry } = uprightToRaw(ux, uy, orientation);
          const idx = (ry * rw + rx) * 4;
          data[idx] = r; data[idx + 1] = g; data[idx + 2] = b; data[idx + 3] = 255;
        }
      }
      ctx.putImageData(imgData, 0, 0);

      const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.98));
      const buf = new Uint8Array(await blob.arrayBuffer());

      const exif = [
        0x45, 0x78, 0x69, 0x66, 0, 0, // "Exif\\0\\0"
        0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, // TIFF MM, IFD0 @ 8
        0, 1, // 1 entry
        0x01, 0x12, 0, 3, 0, 0, 0, 1, (orientation >> 8) & 0xff, orientation & 0xff, 0, 0,
        0, 0, 0, 0,
        0x47, 0x50, 0x53, 0x35, 0x2e, 0x31, // fake GPS data (must be stripped)
      ];
      const app1Len = exif.length + 2;
      const app1 = [0xff, 0xe1, (app1Len >> 8) & 0xff, app1Len & 0xff, ...exif];

      const out = new Uint8Array(buf.length + app1.length);
      out.set(buf.subarray(0, 2), 0);
      out.set(new Uint8Array(app1), 2);
      out.set(buf.subarray(2), 2 + app1.length);

      let binary = "";
      for (let i = 0; i < out.length; i++) binary += String.fromCharCode(out[i]);
      map[orientation] = btoa(binary);
    }
    return map;
  })()`);

  const buffers = {};
  for (let o = 1; o <= 8; o++) {
    buffers[o] = Buffer.from(base64Map[o], "base64");
  }
  return buffers;
}
