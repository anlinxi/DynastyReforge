/**
 * 开发用遥控通道的页面端（只在开发模式且网址带 `?remote` 时加载，见 main.js）。
 * 长轮询 /__ctl/next 取一段 JS，按 async 函数体执行，把返回值 POST 回去。服务端见 verify/remoteControl.mjs。
 */
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

function serialize(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return String(value);
  }
}

export async function startRemoteControl() {
  for (;;) {
    let cmd = null;
    try {
      const res = await fetch('/__ctl/next', { cache: 'no-store' });
      if (res.status === 200) cmd = await res.json();
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!cmd) continue;
    let reply;
    try {
      reply = { id: cmd.id, ok: true, value: serialize(await new AsyncFunction(cmd.code)()) };
    } catch (err) {
      reply = { id: cmd.id, ok: false, value: String(err?.stack ?? err) };
    }
    await fetch('/__ctl/result', { method: 'POST', body: JSON.stringify(reply) }).catch(() => {});
  }
}
