/*
==========================================================================
 文件：app.js  ——  网页的"行为"
==========================================================================
 这个文件是干嘛的？
   HTML 是骨架，CSS 是装修，这个 JS 文件负责"动起来"：
   点按钮数字 +1、根据时间打招呼、自动填年份。

 你会学到什么？
   - 怎么用 document.getElementById 找到页面上的一个元素
   - 监听点击事件（addEventListener）
   - 用状态（变量）保存数据并更新页面
   - 一个小技巧：用"时长读数"算出"几点"（不依赖任何库）

 怎么生效？
   index.html 底部有 <script src="app.js"></script>，
   浏览器解析到那行就会执行本文件。因为放在末尾，
   执行时页面元素都已经存在，不会出现"找不到元素"的问题。

 阅读建议
   从最上面的 CONFIG 往下读，然后看三个 initXxx 函数，
   最后看最底下的"启动"部分——那是整个脚本的入口。
==========================================================================
*/

/* ------------------------------------------------------------------
   0) 严格模式
   写一行 'use strict'，JS 会进入更严格的检查模式：
   比如给未声明的变量赋值会直接报错，而不是默默创建一个全局变量。
   好处：把一些容易忽略的 bug 提前暴露出来。现代项目基本都写。
------------------------------------------------------------------ */
'use strict';

/* ------------------------------------------------------------------
   1) 配置区
   把所有"常数"集中放这里，以后想改文案不用满文件找。
   Object.freeze 表示"冻结"，防止不小心改到这里面的值（改了会报错）。
------------------------------------------------------------------ */
const CONFIG = Object.freeze({
  // 存计数器的 localStorage 键名。localStorage 是浏览器给的本地小仓库，
  // 关掉页面再打开数据还在，相当于"记住了上次的数字"。
  storageKey: 'claw_demo_count',
  // 不同时间段的问候语
  greetingMorning: '早上好，今天也要元气满满 ☀️',
  greetingNoon: '中午好，记得起来活动一下 🍜',
  greetingAfternoon: '下午好，来杯咖啡继续冲 ☕',
  greetingEvening: '晚上好，别熬太晚 🌙'
});

/* ------------------------------------------------------------------
   2) 工具函数：按本地时间算问候语
   @returns {string} 一句问候语
   思路：把"现在几点"拿出来，落在哪个区间就返回哪句话。
   【重点理解】JS 里的 Date 是"时长读数"，getHours() 得到的是
   当前时区的小时数（在 macOS/Windows 上通常是本地时区）。
------------------------------------------------------------------ */
function getGreetingByHour(date = new Date()) {
  // getHours() 返回 0~23 的整数
  const hour = date.getHours();

  if (hour < 11) return CONFIG.greetingMorning;      // 0:00 - 10:59
  if (hour < 14) return CONFIG.greetingNoon;         // 11:00 - 13:59
  if (hour < 18) return CONFIG.greetingAfternoon;    // 14:00 - 17:59
  return CONFIG.greetingEvening;                     // 18:00 - 23:59
}

/* ------------------------------------------------------------------
   3) 初始化计数器
   作用：从 localStorage 读上次的数字 → 绑定按钮点击 → 每次点击 +1。
------------------------------------------------------------------ */
function initCounter() {
  // 通过 id 精确找到页面上那三个元素（"身份证号"找人的感觉）
  const btn = document.getElementById('countBtn');
  const countSpan = document.getElementById('count');

  // 防御性检查：如果页面上没有这个按钮（比如换了页面用同一个脚本），
  // 就直接返回，不要往下跑，否则会报 "Cannot read properties of null"。
  if (!btn || !countSpan) return;

  // localStorage 存的是"字符串"（比如 "3"），所以要用 Number() 转成数字。
  // 如果从来没存过，读出来是 null，Number(null) 是 0，正好当初始值。
  let count = Number(localStorage.getItem(CONFIG.storageKey) || 0);

  // 如果上次存的值被搞坏了（比如存在 "abc"），重置成 0，避免页面显示 NaN
  if (!Number.isFinite(count)) count = 0;

  // 把数字写回页面
  countSpan.textContent = String(count);

  // 监听按钮的点击事件：点一次就执行一次回调函数
  btn.addEventListener('click', () => {
    count += 1;
    countSpan.textContent = String(count);

    // 持久化保存，下次打开还能看到
    localStorage.setItem(CONFIG.storageKey, String(count));

    // 顺手做个"点击涟漪"效果：加个类，动画结束后再移除。
    // classList.add 是"给元素贴标签"，配合 CSS 就能触发动画。
    btn.classList.add('clicked');
    // setTimeout = 延迟执行：150 毫秒后把标签撕掉，这样下次还能再触发
    setTimeout(() => btn.classList.remove('clicked'), 150);
  });
}

/* ------------------------------------------------------------------
   4) 初始化问候语
   作用：把当前时间的问候语填进页面。
------------------------------------------------------------------ */
function initGreeting() {
  const el = document.getElementById('greeting');
  if (!el) return;

  // 先用不带参数的默认值（也就是"此刻"）算一次
  el.textContent = getGreetingByHour();

  // 再让它每分钟刷新一次，跨过整点时会自动更新。
  // 1000 毫秒 = 1 秒，所以 60 * 1000 就是 1 分钟。
  setInterval(() => {
    el.textContent = getGreetingByHour();
  }, 60 * 1000);
}

/* ------------------------------------------------------------------
   5) 初始化页脚年份
   作用：页脚的 © 年份自动跟着系统时间走，不用每年手动改。
------------------------------------------------------------------ */
function initFooterYear() {
  const el = document.getElementById('year');
  if (!el) return;

  // new Date().getFullYear() 返回四位年份，例如 2026
  el.textContent = String(new Date().getFullYear());
}

/* ------------------------------------------------------------------
   6) 启动
   DOMContentLoaded：当 HTML 文档"解析完成"时触发的事件。
   虽然 <script> 已经在底部了，加上它更稳妥：
   万一以后有人把这个脚本挪到 <head> 里，逻辑也不会坏。

   这里同时写一份"立即执行"的兜底，是为了应对一种极少见情况：
   脚本加载得太慢，DOMContentLoaded 早就触发完了，
   此时再监听就永远不会执行——所以直接判断 readyState 手动跑一次。
------------------------------------------------------------------ */
function bootstrap() {
  initCounter();
  initGreeting();
  initFooterYear();

  // 在控制台打一行日志，方便你打开开发者工具确认脚本真的跑起来了
  console.log('[app.js] 页面初始化完成 ✅');
}

if (document.readyState === 'loading') {
  // 文档还在解析中 → 等它解析完再执行
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  // 文档已经就绪 → 立刻执行
  bootstrap();
}
