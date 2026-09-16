/*
  ============================================================================
  文件：src/main.js —— 启动开关（最后一块拼图）
  ============================================================================

  【这个文件是干嘛的？】
  它只有十几行，但作用是"点火"。
  前面的文件都只是**定义**了一堆类和函数，但没有任何代码去**调用**它们 ——
  就像造好了一辆车但还没拧钥匙。这个文件负责拧那把钥匙。

  【你会学到什么？—— DOMContentLoaded 事件】

  ★ 为什么不能直接写 DG.Game.init()？★

  因为 <script> 标签是在 HTML **解析过程中**执行的。
  浏览器读到 <script src="src/main.js"> 时，会立刻下载并执行它 ——
  而此时它后面的 HTML（比如页面上其他元素）可能**还没被解析出来**。

  我们这个项目里，canvas 定义在 <script> 之前，所以理论上能拿到。
  但如果以后你把脚本移到了 <head> 里，或者加了新的 DOM 元素，
  就可能拿到 null，然后报出经典的错误：
      "Cannot read properties of null (reading 'getContext')"

  ★ 解决办法：等 DOM 准备好 ★

  浏览器会在"整个 HTML 都解析完、DOM 树建好了"的时候，
  触发一个叫 DOMContentLoaded 的事件。我们把自己的启动代码
  挂在这个事件上，就能保证"等所有元素都在了再开工"。

  这是所有网页项目都该遵守的基本纪律。即使当前能跑通，
  加上它也能让代码在以后被改动时依然健壮。
  ============================================================================
*/

(function (DG) {
  'use strict';

  /**
   * 真正的启动流程。
   */
  function boot() {
    // 打一行日志，方便确认"脚本确实加载进来了"。
    // 如果控制台里连这行都没有，说明是文件路径写错了或者加载顺序有问题。
    console.log(
      '%c 像素地牢 ',
      'background:#4a7fc1;color:#fff;font-weight:bold;padding:2px 6px;border-radius:3px',
      '正在启动…'
    );

    try {
      DG.Game.init();
    } catch (err) {
      // ★ 为什么要 try / catch？★
      // 游戏启动时如果出错（比如某个精灵名字写错、某个 DOM 元素找不到），
      // 默认情况下浏览器只会在控制台丢一行红字，页面就是一片黑，
      // 用户完全不知道发生了什么。
      //
      // 这里捕获错误并画到屏幕上，至少能让人看到"出了什么问题"，
      // 排查起来会快很多。这是"面向用户的错误处理"的基本意识。
      showBootError(err);
    }
  }

  /**
   * 启动失败时，把错误信息画在页面上。
   * 这样即使不懂技术的用户也能截图给开发者看。
   */
  function showBootError(err) {
    console.error('[Boot] 启动失败：', err);

    const stage = document.getElementById('stage');
    if (!stage) return;

    // 造一个错误提示框盖住画面
    const box = document.createElement('div');
    box.style.cssText = [
      'position:absolute', 'inset:0',
      'background:rgba(20,4,8,0.94)',
      'color:#ff8a8a',
      'font-family:monospace',
      'font-size:12px',
      'line-height:1.7',
      'padding:16px',
      'overflow:auto',
      'white-space:pre-wrap',
      'z-index:99',
    ].join(';');

    box.textContent =
      '启动失败\n\n' +
      (err && err.message ? err.message : String(err)) +
      '\n\n完整错误已打印到浏览器控制台（按 F12 查看）。\n' +
      '常见原因：\n' +
      '  · 某个 src/*.js 文件路径写错或没加载\n' +
      '  · 精灵名字拼写错误（art.js 和 entities.js 对不上）\n' +
      '  · 字符画某一行长度不一致';

    stage.appendChild(box);
  }

  // --------------------------------------------------------------------------
  // 挂在 DOMContentLoaded 上启动
  //
  // 如果在 main.js 执行时 DOM 已经准备好了（比如脚本放在 </body> 之前，
  // 或者浏览器缓存命中执行得特别快），DOMContentLoaded 可能已经错过了，
  // 那事件就永远不会触发。
  //
  // 所以先检查 document.readyState：
  //   'loading'          → 还在解析，等事件
  //   'interactive' / 'complete' → 已经好了，直接启动
  //
  // 这个"先检查再监听"的写法是最可靠的启动模式，被广泛使用。
  // --------------------------------------------------------------------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(window.DG);
