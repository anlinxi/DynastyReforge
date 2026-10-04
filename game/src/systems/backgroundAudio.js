/**
 * App 切到后台（手机回主屏幕、电脑最小化或切走标签页）时停声音，回来再接着放。
 *
 * 背景音乐是浏览器原生音频元素边读边播的（bgm.js），不归 Phaser 管，Phaser 自己的失焦暂停管不到它，
 * 于是 iPhone 回到主屏幕后还在响（用户 2026-10-03 真机报）。这里统一处理：
 * 页面不可见时暂停正在放的背景音乐与影片、挂起 Phaser 音效；可见时只恢复刚才被这里暂停的那些。
 */

/**
 * 后台时要暂停哪些、回前台恢复哪些。纯函数（便于测试）。
 * @param {Array<{paused:boolean}>} media 当前所有音频/影片元素
 * @returns {Array} 正在播放、需要暂停的那些
 */
export function playingMedia(media) {
  return media.filter((el) => el && !el.paused);
}

/**
 * @param {object} opts
 * @param {Phaser.Game} opts.game
 * @param {() => HTMLMediaElement[]} opts.media 取当前所有背景音乐与影片元素
 * @param {Document} [opts.doc]
 */
export function installBackgroundAudio({ game, media, doc = document }) {
  // 关掉 Phaser 的「窗口失焦就挂起整个音效通道」：它要等 focus 事件才恢复，桌面版切窗口后偶尔等不到，
  // 于是整局所有音效（技能、玻璃破碎、对话声）都不响、只剩不归 Phaser 管的音乐（用户 2026-10-03 实玩两次）。
  // 停声音统一按「页面不可见」走下面的处理；窗口可见但没焦点时音效照常响，与音乐一致。
  if (game.sound) game.sound.pauseOnBlur = false;
  let paused = [];
  doc.addEventListener('visibilitychange', () => {
    if (doc.hidden) {
      paused = playingMedia(media());
      for (const el of paused) el.pause();
      game.sound?.pauseAll?.();
      return;
    }
    game.sound?.resumeAll?.();
    for (const el of paused) {
      el.play?.()?.catch?.(() => {}); // 回前台时浏览器偶尔拒播，下一次换曲会重新开始，不必报错
    }
    paused = [];
  });
}
