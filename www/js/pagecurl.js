// The page curl, drawn on the graphics card (WebGL).
//
// The picture of the current page is bent around a cylinder that rolls
// across it, like a sheet of paper lifted by its corner: the fold runs at a
// slant, the curled part shows the back of the sheet (paper with the print
// faintly showing through, mirrored), and the roll throws a soft shadow on
// the page underneath. Where the paper has lifted away, the canvas is clear,
// so the real next page shows through from below.
//
// All maths is in CSS pixels with y pointing down. For a screen point p:
//   d = dot(p, n) - s       its distance past the fold line
// n points from the fold towards the corner that lifts, s is where the fold
// is, R the radius of the roll. Paper that started at distance u past the
// fold now lies at u along the roll (0 <= u <= pi R) or, beyond that, flat on
// top, folded back the other way.

const VERTEX = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

const FRAGMENT = `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uSize;   // canvas size, CSS px
uniform vec2 uLeaf;   // the sheet that curls: x from, x to
uniform vec2 uN;      // unit vector from the fold towards the lifted corner
uniform float uS;     // fold position along uN
uniform float uR;     // radius of the roll
uniform float uDpr;
uniform vec3 uPaper;  // colour of the back of the sheet
uniform float uGhost; // how much print shows through on the back
uniform float uShadow;
uniform float uStill; // 1: draw the facing page that stays put
const float PI = 3.14159265;

vec3 tex(vec2 q) { return texture2D(uTex, q / uSize).rgb; }

// 1 inside the sheet, 0 outside, with a soft one-pixel edge.
float inSheet(vec2 q) {
  float e = min(min(q.x - uLeaf.x, uLeaf.y - q.x), min(q.y, uSize.y - q.y));
  return clamp(e + 0.5, 0.0, 1.0);
}

// premultiplied "over"
vec4 over(vec4 top, vec4 under) { return top + under * (1.0 - top.a); }

void main() {
  vec2 p = vec2(gl_FragCoord.x / uDpr, uSize.y - gl_FragCoord.y / uDpr);
  float d = dot(p, uN) - uS;
  vec4 col = vec4(0.0);

  // Bottom layer: the part of the sheet that has not lifted yet, the facing
  // page, or (where the sheet has gone) clear, with the roll's shadow on it.
  float here = inSheet(p);
  if (here > 0.0) {
    if (d < 0.0) {
      float shade = 1.0 - 0.16 * smoothstep(-uR * 1.6, 0.0, d);
      col = vec4(tex(p) * shade, 1.0) * here;
    } else {
      float reach = uR * 0.7 + 26.0;
      float a = uShadow * (1.0 - smoothstep(uR * 0.6, uR + reach, d));
      col = vec4(0.0, 0.0, 0.0, a * here);
    }
  }
  if (uStill > 0.5 && (p.x < uLeaf.x || p.x > uLeaf.y)) {
    col = vec4(tex(p), 1.0);
  }

  // Top layers: the roll, and the sheet folded back over the page.
  if (d >= 0.0 && d <= uR + 1.0) {
    float t1 = asin(clamp(d / uR, 0.0, 1.0)); // front of the sheet, rising
    float t2 = PI - t1;                       // back of the sheet, coming over
    vec2 q1 = p + (uR * t1 - d) * uN;
    vec2 q2 = p + (uR * t2 - d) * uN;
    float rim = clamp(uR - d + 0.5, 0.0, 1.0);
    vec4 front = vec4(tex(q1) * (1.0 - 0.32 * pow(sin(t1), 1.5)), 1.0) * inSheet(q1) * rim;
    vec3 b = mix(uPaper, tex(q2), uGhost);
    float light = 0.80 + 0.20 * (-cos(t2)) + 0.06 * pow(sin(t2), 8.0);
    vec4 back = vec4(b * light, 1.0) * inSheet(q2) * rim;
    col = over(back, over(front, col));
  } else if (d < 0.0) {
    vec2 q = p + (PI * uR - 2.0 * d) * uN;
    vec3 b = mix(uPaper, tex(q), uGhost);
    // a little darker where it bends over, lighter as it lies flat
    float light = 1.0 - 0.10 * (1.0 - smoothstep(0.0, uR * 1.4, -d));
    vec4 back = vec4(b * light, 1.0) * inSheet(q);
    col = over(back, col);
  }
  gl_FragColor = col;
}
`

function compile(gl, type, src) {
  const s = gl.createShader(type)
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { gl.deleteShader(s); return null }
  return s
}

export function parseColor(css) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(css ?? '').trim())
  if (!m) return [1, 1, 1]
  const n = parseInt(m[1], 16)
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

// The graphics program is built once and kept, so each turn only uploads
// the new picture.
let shared = null
function context() {
  if (shared && !shared.gl.isContextLost()) return shared
  shared = null
  const canvas = document.createElement('canvas')
  let gl = null
  try {
    gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false })
  } catch { gl = null }
  if (!gl) return null
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX)
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
  if (!vs || !fs) return null
  const prog = gl.createProgram()
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
  gl.useProgram(prog)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
  const tex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.disable(gl.BLEND)
  const u = name => gl.getUniformLocation(prog, name)
  const loc = { size: u('uSize'), leaf: u('uLeaf'), n: u('uN'), s: u('uS'), r: u('uR'), dpr: u('uDpr'), paper: u('uPaper'), ghost: u('uGhost'), shadow: u('uShadow'), still: u('uStill'), tex: u('uTex') }
  gl.uniform1i(loc.tex, 0)
  shared = { canvas, gl, loc, max: gl.getParameter(gl.MAX_TEXTURE_SIZE) }
  return shared
}

// Build the program ahead of the first turn (it takes a moment on some phones).
export function warmUpCurl() { try { context() } catch { /* the plain flip is used */ } }

/**
 * Prepare a curl. Returns null when WebGL is not available, so the caller can
 * use the simpler flip.
 *
 * img     decoded picture of the whole area (W x H CSS px)
 * leaf    [x0, x1]: the sheet that curls
 * still   draw the rest of the picture as the facing page that stays put
 * forward which way the sheet goes (true: lifts at the right, travels left)
 * paper   [r, g, b] 0..1, for the back of the sheet
 */
export function createCurl({ img, W, H, leaf, still, forward, paper, dark }) {
  const ctx = context()
  if (!ctx) return null
  const { canvas, gl, loc, max } = ctx
  if (!(img.naturalWidth > 0) || img.naturalWidth > max || img.naturalHeight > max) return null
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = Math.round(W * dpr)
  canvas.height = Math.round(H * dpr)
  Object.assign(canvas.style, { width: `${W}px`, height: `${H}px`, display: 'block', opacity: '1', transition: 'none' })
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
  } catch { return null }
  if (gl.getError() !== gl.NO_ERROR) return null
  gl.uniform2f(loc.size, W, H)
  gl.uniform2f(loc.leaf, leaf[0], leaf[1])
  gl.uniform1f(loc.dpr, canvas.width / W)
  gl.uniform3f(loc.paper, paper[0], paper[1], paper[2])
  gl.uniform1f(loc.ghost, dark ? 0.2 : 0.13)
  gl.uniform1f(loc.shadow, dark ? 0.6 : 0.32)
  gl.uniform1f(loc.still, still ? 1 : 0)
  gl.viewport(0, 0, canvas.width, canvas.height)

  const leafW = leaf[1] - leaf[0]
  const R0 = Math.max(26, Math.min(110, leafW * 0.17))
  const startAngle = 0.34 // radians: the lower corner leads, as when a page is lifted by its corner

  // The fold's direction, radius and place for progress e (0..1).
  function geometry(e) {
    const a = startAngle * (1 - e)
    const n = [forward ? Math.cos(a) : -Math.cos(a), Math.sin(a)]
    const R = Math.max(1.5, R0 * (1 - 0.9 * e))
    const corners = [[leaf[0], 0], [leaf[1], 0], [leaf[0], H], [leaf[1], H]].map(c => c[0] * n[0] + c[1] * n[1])
    // Start just past the corner, so the first frame is the flat page exactly.
    const from = Math.max(...corners) + R * 1.7 + 2
    // Two pages: the sheet ends folded flat over the facing page (the fold at
    // the spine). One page: it rolls on until it has left the screen.
    const to = still ? Math.min(...corners) : Math.min(...corners) - R - 3
    return { n, R, s: from + (to - from) * e }
  }

  function draw(e) {
    if (gl.isContextLost()) return false
    const g = geometry(Math.max(0, Math.min(1, e)))
    gl.uniform2f(loc.n, g.n[0], g.n[1])
    gl.uniform1f(loc.s, g.s)
    gl.uniform1f(loc.r, g.R)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    return true
  }

  // The canvas is kept for the next turn; only take it off the page, and
  // free the picture's memory with a tiny placeholder.
  function destroy() {
    canvas.remove()
    if (!gl.isContextLost()) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
  }

  return { canvas, draw, destroy }
}
