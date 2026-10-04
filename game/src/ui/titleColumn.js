/**
 * 标题页右侧的选项列（語言、畫面、成長、掉寶）。
 *
 * 各选项放进同一列、由样式排成一竖排（`index.html` 的 `.title-options`）：
 * 电脑贴右下、从下往上排；触屏贴右上、从上往下排。手机 App 没有「畫面」时也不会空出一格。
 * 列随标题场景关闭一起移除。
 */
export function titleOptionColumn(scene) {
  let column = document.querySelector('.title-options');
  if (!column) {
    column = document.createElement('div');
    column.className = 'title-options';
    document.body.append(column);
    scene.events.once('shutdown', () => column.remove());
  }
  return column;
}
