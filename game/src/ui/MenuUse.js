import { itemLose, itemKey } from '../systems/storyActions.js';
import {
  SHARED, isWholeParty, itemUsableNow, sharedLine, skillUsableNow, useItem, useKind, useSkill, incenseKind,
} from '../systems/itemUse.js';
import { FIELD_ENCOUNTER_KEY, createFieldEncounter, useIncense } from '../systems/fieldEncounter.js';

/**
 * 菜单里**用一件物品 / 放一门绝学**的流程：「確定使用／取消」框 → （单体绝学）选人 → 结算 → 头顶金光。
 *
 * 状态（`state`）：
 * ```
 * { kind:'item'|'skill', row, rec,
 *   stage:'confirm'|'target',   // confirm=「確定使用／取消」框；target=绝学选人
 *   pick:0|1,                   // 框里停在哪：0 取消、1 確定使用（＝帧号）
 *   target:number }             // 绝学选人时停在第几个成员
 * ```
 * 开着的时候**方向键与回车全部归它**（菜单本体先问 `menu.use`），否则「按↓选取消」会同时把列表光标也移下去。
 *
 * 结算要改菜单持有的队伍/背包并写回场景（`menu.pushState`），关菜单走 `menu.toggle` ——
 * 这些都经 `menu` 调。（2026-10-04 从 MenuScreen 拆出，QA-04；行为不变。）
 */
export class MenuUse {
  /** @param {import('./MenuScreen.js').default} menu */
  constructor(menu) {
    this.menu = menu;
    this.state = null;
  }

  /**
   * 「確定使用／取消」框，以及绝学选人时落在目标身上的记号。
   *
   * ⚠️ **画在 `drawTexts()` 之后** —— 框会盖住底下的说明文字（原作截图里
   * 正是这样：确认框压在说明框上面），而 `parts` 是按加入顺序叠的。
   */
  draw() {
    const use = this.state;
    if (!use) return;
    const menu = this.menu;
    const box = menu.spec.confirmUse?.box;
    if (!box) { console.warn('menus.json 缺 confirmUse，确认框画不出来'); return; }
    if (use.stage === 'confirm') {
      // 帧号即焦点：0=取消高亮、1=確定使用高亮。
      menu.drawElement(box.asset, use.pick, box.x, box.y);
      return;
    }
    // 选人阶段：把目标那一格的小人整个提亮，替代原作的鼠标指针
    // （我们是键盘操作，本来就不显示指针）。
    const bar = menu.spec.partyBar;
    const k = use.target;
    if (!bar || !(k >= 0)) return;
    menu.drawTile(bar.plate.asset, bar.plate.img,
                  bar.slotX[k] + bar.plate.x, bar.slotY + bar.plate.y, 0.6);
  }

  /**
   * 按下确定，试着开始一次使用。开得起来返回 true。
   *
   * 原作没有「使用」按钮（法宝页底下那两个是分发与弃置，逐帧渲染确认过），
   * 所以入口就是**在列表上按确定**，见 `docs/归档/方案-物品使用.md` §〇.3。
   */
  begin() {
    const menu = this.menu;
    if (menu.focus !== 2) return false;
    const key = menu.page?.key;
    const row = menu.currentRow();
    if (!row) return false;
    const rec = row.记录 ?? menu.catalog.物品(row.代码);
    const start = (kind) => ({ kind, row, rec, stage: 'confirm', pick: 1, target: menu.party.选中 });
    if (key === '法宝' && itemUsableNow(rec)) { this.state = start('item'); menu.render(); return true; }
    if (key === '绝学' && skillUsableNow(rec)) { this.state = start('skill'); menu.render(); return true; }
    return false;
  }

  /** 方向键。`step` 是 ↑↓ 的量、`dir` 是 ←→ 的量，只会有一个非 0。 */
  navigate(step, dir) {
    const use = this.state;
    if (use.stage === 'confirm') {
      // 框里只有两行，↑↓ 在两行之间走。←→ 不管（原作那个框没有横向选项）。
      if (step) this.state = { ...use, pick: use.pick ? 0 : 1 };
      this.menu.render();
      return;
    }
    // 选人：←→ 在队伍条上走，两端循环。
    const n = this.menu.party.members.length;
    if (dir) this.state = { ...use, target: ((use.target + dir) % n + n) % n };
    this.menu.render();
  }

  /** 回车。 */
  confirm() {
    const use = this.state;
    if (use.stage === 'confirm') {
      if (!use.pick) { this.cancel(); return; }
      // 单体绝学要先选人（原作行为）；物品与全体绝学直接落地。
      if (use.kind === 'skill' && !isWholeParty(use.rec)) {
        this.state = { ...use, stage: 'target' };
        this.menu.render();
        return;
      }
    }
    this.commit();
  }

  cancel() {
    this.state = null;
    this.menu.render();
  }

  /** 真的用下去。 */
  commit() {
    const { kind, rec, row, target } = this.state;
    this.state = null;
    if (kind === 'item') this.commitItem(rec, row, target);
    else this.commitSkill(rec, target);
  }

  /**
   * 用一件物品：算效果 → 扣一个 → 放特效。
   *
   * ⚠️ **剧情道具（钥匙、碎片…）不消耗、不回血** —— 原作是切回地图找对象用，
   * 用错地方就弹一句「這樣東西似乎不是在此處使用。」。这一版只做后半边，
   * 见 `docs/归档/方案-物品使用.md` §四.5。
   */
  commitItem(rec, row, target) {
    const menu = this.menu;
    const scene = menu.scene;
    const incense = incenseKind(rec);
    if (incense) {
      const lost = itemLose(menu.inventory, row.代码, 1);
      if (!lost.ok) return;
      const state = scene.registry.get(FIELD_ENCOUNTER_KEY) ?? createFieldEncounter();
      useIncense(state, incense);
      scene.registry.set(FIELD_ENCOUNTER_KEY, state);
      menu.inventory = lost.inventory;
      menu.pushState();
      menu.toggle();
      scene.sayLine?.(sharedLine(scene, incense === 'calm' ? SHARED.WARD_CALM : SHARED.WARD_LURE));
      return;
    }
    if (useKind(rec) === 'returnCharm') {
      menu.toggle();
      // 不可用地图原作只弹提示；是否扣物品未见依据，按不扣处理（台账R-UI-05）。
      if (!scene.meta?.returnCharm) {
        scene.sayLine?.(sharedLine(scene, SHARED.LEY_LINES));
        return;
      }
      const lost = itemLose(menu.inventory, row.代码, 1);
      if (!lost.ok) return;
      menu.inventory = lost.inventory;
      menu.pushState();
      scene.useReturnCharm?.();
      return;
    }
    if (useKind(rec) === 'story') {
      menu.toggle();                       // 关菜单，回地图
      scene.heldItem = parseInt(itemKey(row.代码), 16);
      return;
    }
    const out = useItem(menu.party, rec, target);
    menu.party = out.party;
    const lost = itemLose(menu.inventory, row.代码, 1);
    if (!lost.ok) console.warn(`用了 ${rec?.名称} 但背包里扣不掉，数量对不上`);
    menu.inventory = lost.inventory;
    menu.pushState();
    menu.clampCursor();
    menu.render();
    menu.useFx.play(out.targets);
  }

  /** 放一门绝学：扣施法者元气 → 回复 → 放特效。施法者＝当前 Tab 那个人。 */
  commitSkill(rec, target) {
    const menu = this.menu;
    const out = useSkill(menu.party, rec, menu.party.选中, target);
    if (!out.ok) { menu.render(); return; }   // 元气不够，一点不扣
    menu.party = out.party;
    menu.pushState();
    menu.render();
    menu.useFx.play(out.targets);
  }

  /** 确认框两行 / 选人时队伍条各格的点击区。 */
  buildHits() {
    const menu = this.menu;
    const use = this.state;
    const cfg = menu.spec.confirmUse;
    if (use.stage === 'confirm') {
      if (!cfg) return;
      for (const h of cfg.hits ?? []) {
        const pick = h.role === 'confirm' ? 1 : 0;
        menu.addZone(
          { x: cfg.box.x + h.x, y: cfg.box.y + h.y, w: h.w, h: h.h },
          () => { if (this.state && this.state.pick !== pick) { this.state = { ...this.state, pick }; menu.queueRender(); } },
          () => { if (h.role === 'confirm') this.confirm(); else this.cancel(); },
        );
      }
      return;
    }
    const bar = menu.spec.partyBar;
    const [w, h] = menu.spec.assets?.[bar?.plate?.asset]?.sizes?.[bar?.plate?.img] ?? [0, 0];
    if (!bar || !w) return;
    menu.party.members.slice(0, bar.slots).forEach((_, k) => {
      menu.addZone(
        { x: bar.slotX[k] + bar.plate.x, y: bar.slotY + bar.plate.y, w, h },
        () => { if (this.state && this.state.target !== k) { this.state = { ...this.state, target: k }; menu.queueRender(); } },
        () => { if (this.state) { this.state = { ...this.state, target: k }; this.confirm(); } },
      );
    });
  }
}

