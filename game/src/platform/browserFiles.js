/** 浏览器文件选择与下载边界；不解释TSF内容，不修改游戏状态。
 * 桌面/手机移植时替换此入口，字节编码与存储后端仍复用现有模块。
 */
// ————————————————————————————————————————————————————————————
// 导出 / 导入 `.TSF`
// ————————————————————————————————————————————————————————————

/** 把字节存成文件下载。文件名抄原作：`SaveNNN.TSF`。 */
export function downloadTsf(bytes, slot) {
  const name = `Save${String(Number(slot) + 1).padStart(3, '0')}.TSF`;
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 在部分浏览器上会让下载失败，等一拍。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}

/** 弹文件选择框，读回 `.TSF` 字节。取消则 resolve(null)。 */
export function pickTsf() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.TSF,.tsf';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      file.arrayBuffer()
        .then((buf) => resolve(new Uint8Array(buf)))
        .catch((err) => {
          console.warn('读取 .TSF 失败：', err?.message ?? err);
          resolve(null);
        });
    };
    // ⚠️ 用户点「取消」时 `change` **不会触发**，这个 Promise 就永远挂着。
    // 挂着不会报错，只会让界面按钮再也没反应 —— 用 focus 兜一道。
    window.addEventListener('focus', () => {
      setTimeout(() => { if (!input.files?.length) resolve(null); }, 500);
    }, { once: true });
    input.click();
  });
}
