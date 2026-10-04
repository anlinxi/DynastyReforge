/**
 * 手机安全区：iPhone 横屏时两侧有灵动岛/刘海和圆角，画面要避开（PLAT-01）。
 *
 * index.html 的 viewport 设了 `viewport-fit=cover`（页面铺满整块屏幕，两侧黑底也盖住），
 * body 用 `env(safe-area-inset-*)` 内边距把画布居中在安全区里；这里读出同样的数值，
 * 让舞台宽度与放大倍数按安全区算。电脑上这些值都是 0，行为不变。
 */

let probe = null;

function ensureProbe(doc) {
  if (!probe) {
    probe = doc.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;'
      + 'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    doc.body.append(probe);
  }
  return probe;
}

/**
 * 安全区数值变化时回调（探针的内边距一变，它的外框尺寸就变）。
 * iPhone 上安全区常在页面加载之后才补上，窗口尺寸却不变、不发 resize，必须单独盯着。
 */
export function onSafeAreaChange(callback, doc = document) {
  const el = ensureProbe(doc);
  const Observer = doc.defaultView?.ResizeObserver;
  if (!Observer) return () => {};
  // 开始观察时会先报一次当前值：不跳过——安全区可能恰在这之前变了；重排在尺寸没变时什么都不做
  const observer = new Observer(() => callback());
  observer.observe(el, { box: 'border-box' });
  return () => observer.disconnect();
}

/** 读 CSS 的安全区内边距（px）。 */
export function safeInsets(doc = document) {
  ensureProbe(doc);
  const cs = doc.defaultView.getComputedStyle(probe);
  const px = (v) => Number.parseFloat(v) || 0;
  return { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
}

/** 扣掉安全区后可用来画游戏的窗口尺寸。 */
export function safeViewport(win = window) {
  const i = safeInsets(win.document);
  return {
    width: Math.max(1, win.innerWidth - i.left - i.right),
    height: Math.max(1, win.innerHeight - i.top - i.bottom),
  };
}
