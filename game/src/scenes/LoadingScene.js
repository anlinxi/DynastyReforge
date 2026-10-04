import Phaser from 'phaser';
import { STAGE_WIDTH, STAGE_HEIGHT } from '../config.js';
import { band, ensureMapWithSource } from '../systems/loader.js';
import { ensureBattleBasics } from '../systems/battleBasics.js';
import { stopBgm } from '../systems/bgm.js';
import { centerLegacyScene } from '../systems/stageView.js';

/** 地图占加载页进度的比例，其余是战斗基础素材（见 `battleBasics.js`）。 */
const MAP_SHARE = 0.4;

/**
 * **加载页 —— 一块纯黑 + 居中一行字。**
 *
 * ## 为什么要单独一个场景
 *
 * 用户 2026-09-13 报：「不论是读取存档切换地图，还是死了之后播放败阵，
 * 中间都有一段间隙会显示当前的（上一张地图的）游戏画面，很不和谐也容易
 * 出现意想不到的问题」。
 *
 * 成因：`FieldScene.enterAfterLoad` 的设计前提是「**加载放在黑幕里**」——
 * 那是给剧情 `goto_map` 写的，因为脚本在 `goto_map` 前面本来就有一条
 * `fade_out`，此刻画面已经全黑。而**读档没有任何黑幕**，于是
 * `ensureMap` 那几百毫秒里旧地图一直亮着。
 *
 * 只盖一张黑矩形不够：那样**旧场景还在活着跑 `update()`** ——
 * 主角能走、NPC 在动、踩踏判定照样触发。用户说的「容易出现意想不到的
 * 问题」就是这个。走一个独立场景，`scene.start` 把旧场景**停掉**。
 *
 * ## 这是 🔵 架构新增，原作没有
 *
 * 原作是本地读盘、几乎瞬间，**没有「加载中」这个画面**。
 * 提示用系统字「载入中… N%」，与开机、战斗的加载提示统一（用户 2026-09-27：
 * 原作「讀取中」横幅只在天书读档一处，统一成「载入中」，并且要有百分比）。
 * 百分比是三轮加载合成的总进度，见 `loader.js` 的 `band`。
 */
export default class LoadingScene extends Phaser.Scene {
  constructor() {
    super('Loading');
  }

  /**
   * @param {object} data
   * @param {string} data.mapId 要进的图；给了就先 `ensureMap` 再走
   * @param {object|null} [data.entry] 落点，原样转给 `FieldScene`
   * @param {boolean} [data.defeat] 转给 `FieldScene`，让它进去就演败阵
   * @param {string} [data.text] 中间那行字
   * @param {boolean} [data.silent] 进来就把 BGM 停掉（读档要，败阵不要）
   * @param {boolean} [data.opening] 转给 `FieldScene`：新游戏演开场
   * @param {number} [data.hintDelayMs] 过这么久还没载完才显示那行字（标题进游戏用，
   *   与切图同一规则；瞬间载完就只是一下黑屏，不闪字）。不给就立刻显示。
   */
  init(data) {
    centerLegacyScene(this);
    this.mapId = data?.mapId ?? null;
    this.entry = data?.entry ?? null;
    this.defeat = data?.defeat === true;
    this.text = data?.text ?? '载入中…';
    this.silent = data?.silent === true;
    this.opening = data?.opening === true;
    this.hintDelayMs = data?.hintDelayMs ?? 0;
  }

  create() {
    this.cameras.main.setBackgroundColor('#000000');
    const label = this.add.text(STAGE_WIDTH / 2, STAGE_HEIGHT / 2, this.text,
                                { fontFamily: 'serif', fontSize: '20px', color: '#d8c9a3' })
      .setOrigin(0.5).setScrollFactor(0).setVisible(!this.hintDelayMs);
    let shown = 0;
    const onProgress = (v) => {
      shown = Math.max(shown, v);
      if (label.active) label.setText(`${this.text} ${Math.round(shown * 100)}%`);
    };
    if (this.hintDelayMs) this.time.delayedCall(this.hintDelayMs, () => label.setVisible(true));

    // ⚠️ **读档要停曲子。** 读档相当于换了一局，旧图那首不能带过去；
    // 而败阵那一趟不停 —— 槽 9 自己会 `play_audio 31`。
    if (this.silent) stopBgm(this);

    if (!this.mapId) { this.go(); return; }
    // ⚠️ **加载失败也必须走下去。** 卡在这一页上玩家什么都做不了，
    // 而且没有任何提示。拉不到就照样进 —— `FieldScene.create()` 自己还有
    // 一道「资源没到就先拉」的闸。
    // 地图之后接着载战斗基础素材（界面、本队动作与普攻、蓄劲姿势…），首战入场只剩本场的
    // 背景与敌人，快的话直接碎开进战斗（用户 2026-09-28）。已载过的跳过，同队读档几乎不花时间。
    ensureMapWithSource(this, this.mapId, band(onProgress, 0, MAP_SHARE))
      .catch((err) => console.warn(`加载页：${this.mapId} 拉不到 —— `
                                   + `${err?.message ?? err}，仍然进图`))
      .then(() => ensureBattleBasics(this, band(onProgress, MAP_SHARE, 1)))
      .then(() => this.go());
  }

  go() {
    this.scene.start('Field', {
      mapId: this.mapId ?? undefined,
      entry: this.entry,
      defeat: this.defeat,
      opening: this.opening,
    });
  }
}
