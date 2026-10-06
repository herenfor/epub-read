/** FX-2: experimental color-vision assistance, not a simulation filter. */
export type AssistKind = "off" | "protan" | "deutan" | "tritan";
export type Matrix3 = readonly number[]; // row-major, nine coefficients

const IDENTITY: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Machado et al. 2009 author table, severity=1, linear RGB. */
const SIMULATION: Record<Exclude<AssistKind, "off">, Matrix3> = {
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900],
};

/** Reader policy v1, heuristic weights; not author-calibrated correction matrices. */
const REDISTRIBUTION: Record<Exclude<AssistKind, "off">, Matrix3> = {
  protan: [0, 0, 0, 0.7, 1, 0, 0.7, 0, 1],
  deutan: [1, 0.7, 0, 0, 0, 0, 0, 0.7, 1],
  tritan: [1, 0, 0.7, 0, 1, 0.7, 0, 0, 0],
};

/** C = I + strength * R * (I - S). Fuse before rendering to avoid an intermediate clamp. */
export function correctionMatrix(kind: AssistKind, strength: number): Matrix3 {
  if (kind === "off" || strength === 0) return IDENTITY;
  const simulation = SIMULATION[kind];
  // Published table rounding gives 1e-6 neutral-axis error. Normalize rows once.
  const s = simulation.map((value, index) => {
    const row = Math.floor(index / 3) * 3;
    return value / (simulation[row] + simulation[row + 1] + simulation[row + 2]);
  });
  const error = s.map((value, index) => IDENTITY[index] - value);
  const redistribution = REDISTRIBUTION[kind];
  return IDENTITY.map((value, index) => {
    const row = Math.floor(index / 3);
    const column = index % 3;
    let product = 0;
    for (let k = 0; k < 3; k++) {
      product += redistribution[row * 3 + k] * error[k * 3 + column];
    }
    return value + strength * product;
  });
}

/** SVG feColorMatrix uses 4x5, straight color channels; alpha stays identity. */
export function svgMatrixValues(matrix: Matrix3): string {
  return [matrix[0], matrix[1], matrix[2], 0, 0,
    matrix[3], matrix[4], matrix[5], 0, 0,
    matrix[6], matrix[7], matrix[8], 0, 0,
    0, 0, 0, 1, 0].join(" ");
}

const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const encoded = (value: number) => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;

/** Small preview swatches only; book pixels stay in GPU SVG filters. RGB/alpha in 0..1. */
export function previewColor(matrix: Matrix3, rgba: readonly [number, number, number, number]) {
  const input = rgba.slice(0, 3).map(linear);
  const rgb = [0, 1, 2].map((row) => {
    let output = 0;
    for (let k = 0; k < 3; k++) output += matrix[row * 3 + k] * input[k];
    return encoded(Math.max(0, Math.min(1, output)));
  });
  return [rgb[0], rgb[1], rgb[2], rgba[3]] as const;
}
