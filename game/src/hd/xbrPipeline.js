import Phaser from 'phaser';

/**
 * xBR 实时像素放大（UI-10 H4 试做）：人物精灵与点阵字画到放大后的画布上时，
 * 按原图像素做边缘判断，斜边变平滑，不改素材、不增内存。
 *
 * **单一管线**（2026-09-30 重写）：以原生多贴图管线为底，所有东西都走它，保留一次合并 16 张贴图；
 * 要不要 xBR 由物件自带标记 `ycXbr` 决定，写进顶点已有的 tintEffect（+4），不切换管线。
 * 先前"只给人物挂单独的 xBR 管线"时，地图上人物与房屋交错绘制，每画一个人物就切一次管线并同步显卡，
 * 沙州城 182 个对象实测 6.6 帧。贴图尺寸放在 uniform 数组里，每批按贴图槽位上传，顶点着色器按贴图号取出。
 *
 * 片元着色器改自 Hyllian 的 xBR-lv2（libretro/glsl-shaders，MIT 许可，版权声明见下）：
 * - 原版只比 RGB；我们的精灵带透明，贴图是预乘透明度，比较与混合都改为 RGBA，
 *   否则黑描边和透明底亮度都接近 0，分不出边；
 * - 放大倍数 XBR_SCALE 改为 uniform（随屏幕倍率变），纹理尺寸按贴图槽位传入；
 * - 末尾照 Phaser Multi.frag 保留染色与闪白（tintEffect）。
 *
 * Copyright (C) 2011-2016 Hyllian - sergiogdb@gmail.com
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify, merge,
 * publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
 * to whom the Software is furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 */
function samplerChain(n) {
  const lines = ['vec4 T(vec2 uv) {'];
  for (let i = 0; i < n - 1; i += 1) lines.push(`  if (outTexId < ${i}.5) return texture2D(uMainSampler[${i}], uv);`);
  lines.push(`  return texture2D(uMainSampler[${n - 1}], uv);`, '}');
  return lines.join('\n');
}

function buildFrag(n) {
  return `
#define SHADER_NAME YC_HD_FS
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform sampler2D uMainSampler[${n}];
uniform float uScale;

varying vec2 outTexCoord;
varying float outTexId;
varying float outTintEffect;
varying vec4 outTint;
varying vec2 outTexSize;

const float XBR_EQ_THRESHOLD = 15.0;
const float LV2_CF = 2.0;
const vec4 W = vec4(14.352, 28.176, 5.472, 48.0);

const vec4 Ao = vec4( 1.0, -1.0, -1.0, 1.0 );
const vec4 Bo = vec4( 1.0,  1.0, -1.0,-1.0 );
const vec4 Co = vec4( 1.5,  0.5, -0.5, 0.5 );
const vec4 Ax = vec4( 1.0, -1.0, -1.0, 1.0 );
const vec4 Bx = vec4( 0.5,  2.0, -0.5,-2.0 );
const vec4 Cx = vec4( 1.0,  1.0, -0.5, 0.0 );
const vec4 Ay = vec4( 1.0, -1.0, -1.0, 1.0 );
const vec4 By = vec4( 2.0,  0.5, -2.0,-0.5 );
const vec4 Cy = vec4( 2.0,  0.0, -1.0, 0.5 );
const vec4 Ci = vec4(0.25);

vec4 df(vec4 A, vec4 B) { return abs(A - B); }
vec4 diff(vec4 A, vec4 B) { return vec4(notEqual(A, B)); }
vec4 eq(vec4 A, vec4 B) { return step(df(A, B), vec4(XBR_EQ_THRESHOLD)); }
vec4 neq(vec4 A, vec4 B) { return vec4(1.0) - eq(A, B); }
vec4 wd(vec4 a, vec4 b, vec4 c, vec4 d, vec4 e, vec4 f, vec4 g, vec4 h) {
  return df(a,b) + df(a,c) + df(d,e) + df(d,f) + 4.0*df(g,h);
}
float c_df(vec4 c1, vec4 c2) { vec4 d = abs(c1 - c2); return d.r + d.g + d.b + d.a; }

%SAMPLER%

vec4 xbr() {
  vec2 texSize = outTexSize;
  vec2 d = 1.0 / texSize;
  float dx = d.x, dy = d.y;
  vec2 tc = outTexCoord;
  // 取到所在原图像素的中心，邻格按整像素偏移
  vec2 px0 = (floor(tc * texSize) + 0.5) * d;
  vec2 fp = fract(tc * texSize);

  // 快路：中心与上下左右四邻亮度值都相同（透明底、纯色块）时，xBR 的边缘判断全为 0，
  // 输出就是中心像素本身——先取这 5 个，相同就直接返回，省掉其余 16 次取样。结果与完整计算一致。
  vec4 E  = T(px0);
  vec4 B  = T(px0 + vec2(0.0,-dy)), D = T(px0 + vec2(-dx,0.0));
  vec4 F  = T(px0 + vec2(dx,0.0)),  H = T(px0 + vec2(0.0,dy));
  float eW = dot(E,W);
  if (eW == dot(B,W) && eW == dot(D,W) && eW == dot(F,W) && eW == dot(H,W)) return E;

  vec4 A1 = T(px0 + vec2(-dx,-2.0*dy)), B1 = T(px0 + vec2(0.0,-2.0*dy)), C1 = T(px0 + vec2(dx,-2.0*dy));
  vec4 A  = T(px0 + vec2(-dx,-dy)),     C  = T(px0 + vec2(dx,-dy));
  vec4 G  = T(px0 + vec2(-dx,dy)),      I  = T(px0 + vec2(dx,dy));
  vec4 G5 = T(px0 + vec2(-dx,2.0*dy)),  H5 = T(px0 + vec2(0.0,2.0*dy)),  I5 = T(px0 + vec2(dx,2.0*dy));
  vec4 A0 = T(px0 + vec2(-2.0*dx,-dy)), D0 = T(px0 + vec2(-2.0*dx,0.0)), G0 = T(px0 + vec2(-2.0*dx,dy));
  vec4 C4 = T(px0 + vec2(2.0*dx,-dy)),  F4 = T(px0 + vec2(2.0*dx,0.0)),  I4 = T(px0 + vec2(2.0*dx,dy));

  vec4 b = vec4(dot(B,W), dot(D,W), dot(H,W), dot(F,W));
  vec4 c = vec4(dot(C,W), dot(A,W), dot(G,W), dot(I,W));
  vec4 dd = b.yzwx;
  vec4 e = vec4(dot(E,W));
  vec4 f = b.wxyz;
  vec4 g = c.zwxy;
  vec4 h = b.zwxy;
  vec4 i = c.wxyz;
  vec4 i4 = vec4(dot(I4,W), dot(C1,W), dot(A0,W), dot(G5,W));
  vec4 i5 = vec4(dot(I5,W), dot(C4,W), dot(A1,W), dot(G0,W));
  vec4 h5 = vec4(dot(H5,W), dot(F4,W), dot(B1,W), dot(D0,W));
  vec4 f4 = h5.yzwx;

  float s = max(uScale, 1.0);
  vec4 delta = vec4(1.0 / s);
  vec4 delta_l = vec4(0.5 / s, 1.0 / s, 0.5 / s, 1.0 / s);
  vec4 delta_u = delta_l.yxwz;

  vec4 fx   = Ao*fp.y + Bo*fp.x;
  vec4 fx_l = Ax*fp.y + Bx*fp.x;
  vec4 fx_u = Ay*fp.y + By*fp.x;

  vec4 irlv0 = diff(e,f) * diff(e,h);
  vec4 irlv1 = irlv0 * (neq(f,b) * neq(f,c) + neq(h,dd) * neq(h,g)
    + eq(e,i) * (neq(f,f4) * neq(f,i4) + neq(h,h5) * neq(h,i5)) + eq(e,g) + eq(e,c));
  vec4 irlv2l = diff(e,g) * diff(dd,g);
  vec4 irlv2u = diff(e,c) * diff(b,c);

  vec4 fx45i = clamp((fx   + delta   - Co - Ci) / (2.0*delta  ), 0.0, 1.0);
  vec4 fx45  = clamp((fx   + delta   - Co     ) / (2.0*delta  ), 0.0, 1.0);
  vec4 fx30  = clamp((fx_l + delta_l - Cx     ) / (2.0*delta_l), 0.0, 1.0);
  vec4 fx60  = clamp((fx_u + delta_u - Cy     ) / (2.0*delta_u), 0.0, 1.0);

  vec4 wd1 = wd(e, c, g, i, h5, f4, h, f);
  vec4 wd2 = wd(h, dd, i5, f, i4, b, e, i);

  vec4 edri  = step(wd1, wd2) * irlv0;
  vec4 edr   = step(wd1 + vec4(0.1), wd2) * step(vec4(0.5), irlv1);
  vec4 edr_l = step(LV2_CF*df(f,g), df(h,c)) * irlv2l * edr;
  vec4 edr_u = step(LV2_CF*df(h,c), df(f,g)) * irlv2u * edr;

  fx45  = edr   * fx45;
  fx30  = edr_l * fx30;
  fx60  = edr_u * fx60;
  fx45i = edri  * fx45i;

  vec4 px = step(df(e,f), df(e,h));
  vec4 maximos = max(max(fx30, fx60), max(fx45, fx45i));

  vec4 res1 = E;
  res1 = mix(res1, mix(H, F, px.x), maximos.x);
  res1 = mix(res1, mix(B, D, px.z), maximos.z);
  vec4 res2 = E;
  res2 = mix(res2, mix(F, B, px.y), maximos.y);
  res2 = mix(res2, mix(D, H, px.w), maximos.w);
  return mix(res1, res2, step(c_df(E, res1), c_df(E, res2)));
}

void main () {
  // tintEffect ≥ 4 表示这块要 xBR（物件标记），其余与 Phaser Multi.frag 相同
  bool useXbr = outTintEffect > 3.5;
  float effect = useXbr ? outTintEffect - 4.0 : outTintEffect;
  vec4 texture;
  if (useXbr) texture = xbr();
  else texture = T(outTexCoord);
  vec4 texel = vec4(outTint.bgr * outTint.a, outTint.a);
  vec4 color = texture * texel;
  if (effect == 1.0) {
    color.rgb = mix(texture.rgb, outTint.bgr * outTint.a, texture.a);
  } else if (effect == 2.0) {
    color = texel;
  }
  gl_FragColor = color;
}
`.replace('%SAMPLER%', samplerChain(n));
}

function buildVert(n) {
  return `
#define SHADER_NAME YC_HD_VS
precision mediump float;

uniform mat4 uProjectionMatrix;
uniform vec2 uResolution;
uniform vec2 uTexSize[${n}];

attribute vec2 inPosition;
attribute vec2 inTexCoord;
attribute float inTexId;
attribute float inTintEffect;
attribute vec4 inTint;

varying vec2 outTexCoord;
varying float outTexId;
varying float outTintEffect;
varying vec4 outTint;
varying vec2 outTexSize;

void main () {
  gl_Position = uProjectionMatrix * vec4(inPosition, 1.0, 1.0);
  outTexCoord = inTexCoord;
  outTexId = inTexId;
  outTint = inTint;
  outTintEffect = inTintEffect;
  outTexSize = uTexSize[int(inTexId + 0.5)];
}
`;
}

export const XBR_PIPELINE = 'YcHd';

/**
 * 面积超过这个值（逻辑像素²，四分之一屏）的图即使带标记也不走 xBR。
 * xBR 每个屏幕像素取 21 次纹理；整屏的大图多是写实 JPEG，xBR 几乎没有改善。
 */
const PLAIN_AREA = (640 * 480) / 4;

/** 诊断：`hdxbr=plain` 所有物件都不做 xBR（仍走这条管线），用来区分着色器开销。 */
const FORCE_PLAIN = (() => {
  try {
    return new URLSearchParams(window.location.search).get('hdxbr') === 'plain';
  } catch {
    return false;
  }
})();

export class XbrPipeline extends Phaser.Renderer.WebGL.Pipelines.MultiPipeline {
  constructor(game) {
    const n = game.renderer.maxTextures;
    super({ game, name: XBR_PIPELINE, fragShader: buildFrag(n), vertShader: buildVert(n) });
    this.slots = n;
    this.sizes = new Float32Array(n * 2).fill(1);
    this.scale = 1;
  }

  /** 放大倍数（屏幕像素 / 逻辑像素），由 hdRender 在画布尺寸变化时设置。 */
  setScale(scale) {
    this.flush();
    this.scale = scale;
    this.set1f('uScale', scale);
  }

  onBind() {
    this.set1f('uScale', this.scale);
  }

  /** 带 ycXbr 标记、且不是大图的四边形：tintEffect +4，着色器据此做 xBR。 */
  batchQuad(gameObject, x0, y0, x1, y1, x2, y2, x3, y3, u0, v0, u1, v1, tintTL, tintTR, tintBL, tintBR, tintEffect, texture, unit) {
    let effect = tintEffect;
    if (gameObject?.ycXbr && !FORCE_PLAIN) {
      const area = Math.hypot(x3 - x0, y3 - y0) * Math.hypot(x1 - x0, y1 - y0);
      if (area <= PLAIN_AREA) effect = (tintEffect ?? 0) + 4;
    }
    return super.batchQuad(gameObject, x0, y0, x1, y1, x2, y2, x3, y3, u0, v0, u1, v1, tintTL, tintTR, tintBL, tintBR, effect, texture, unit);
  }

  /**
   * 与 WebGLPipeline.flush 相同，只多一步：每批绘制前按贴图槽位上传贴图尺寸（uTexSize 数组）。
   */
  flush(isPostFlush = false) {
    if (this.vertexCount > 0) {
      this.emit(Phaser.Renderer.WebGL.Pipelines.Events.BEFORE_FLUSH, this, isPostFlush);
      this.onBeforeFlush(isPostFlush);
      const gl = this.gl;
      const vertexCount = this.vertexCount;
      const vertexSize = this.currentShader.vertexSize;
      if (this.active) {
        this.setVertexBuffer();
        if (vertexCount === this.vertexCapacity) gl.bufferData(gl.ARRAY_BUFFER, this.vertexData, gl.DYNAMIC_DRAW);
        else gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.bytes.subarray(0, vertexCount * vertexSize));
        const program = this.currentShader.program.webGLProgram;
        if (this.sizeProgram !== program) {
          this.sizeProgram = program;
          this.sizeLocation = gl.getUniformLocation(program, 'uTexSize[0]');
        }
        const location = this.sizeLocation;
        const active = this.activeTextures;
        for (const entry of this.batch) {
          for (let t = 0; t <= entry.maxUnit; t += 1) {
            const texture = entry.texture[t];
            if (active[t] !== texture) {
              gl.activeTexture(gl.TEXTURE0 + t);
              gl.bindTexture(gl.TEXTURE_2D, texture.webGLTexture);
              active[t] = texture;
            }
            this.sizes[t * 2] = texture.width || 1;
            this.sizes[t * 2 + 1] = texture.height || 1;
          }
          if (location) gl.uniform2fv(location, this.sizes);
          gl.drawArrays(this.topology, entry.start, entry.count);
        }
      }
      this.vertexCount = 0;
      this.batch.length = 0;
      this.currentBatch = null;
      this.currentTexture = null;
      this.currentUnit = 0;
      this.emit(Phaser.Renderer.WebGL.Pipelines.Events.AFTER_FLUSH, this, isPostFlush);
      this.onAfterFlush(isPostFlush);
    }
    return this;
  }
}
