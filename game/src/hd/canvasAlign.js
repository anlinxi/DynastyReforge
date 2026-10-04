/**
 * 画布像素尺寸，并让它在窗口里居中时左右（上下）留边是**整数设备像素**。
 * 留边是半个设备像素时，浏览器把整张画布重采样，全画面（尤其点阵字）发糊。
 * 宽屏的舞台宽度与窗口高度没有固定比例，4:3 时恰好整除的巧合就没了（2026-10-02 用户反馈字更糊）。
 */
export function alignedCanvasSize(width, height, win = typeof window === 'undefined' ? null : window) {
  let w = Math.round(width);
  let h = Math.round(height);
  if (!win) return { w, h };
  const dpr = win.devicePixelRatio || 1;
  const devW = Math.round(win.innerWidth * dpr);
  const devH = Math.round(win.innerHeight * dpr);
  if (w < devW && (devW - w) % 2) w -= 1;
  if (h < devH && (devH - h) % 2) h -= 1;
  return { w, h };
}
