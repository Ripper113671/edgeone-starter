/*
  ============================================================================
  文件：src/input.js —— 键盘输入管理（游戏怎么"听见"你按键）
  ============================================================================

  【这个文件是干嘛的？】
  监听键盘，把"按下 / 松开"翻译成游戏能理解的动作。
  玩家按住 W+D，我们要知道"该往右上走"；松开 D 后，还要知道"右方向没了"。

  【你会学到什么？】
  1. keydown（按下）/ keyup（松开）两种事件。
  2. ★ 核心设计：状态 与 边缘 ★
     - held（状态）：现在按着吗？  → 持续移动用它
     - pressed（边缘）：这一帧刚按下吗？→ 开始游戏、攻击用它，避免连发
     不区分这两者，就会出现"按住攻击键无限连击"这种经典 bug。
  3. event.code 而不是 event.key：
     key 受输入法/键盘布局影响（中文输入法下按 W 可能给你别的值），
     code 只认物理位置（KeyW 永远代表 W 键位）。游戏一律用 code。

  【阅读建议】
  重点对比 held / pressed / released 三个集合的区别，这是通用输入模型。
  ============================================================================
*/

(function (DG) {
  'use strict';

  // ==========================================================================
  // 一、三个状态集合
  // ==========================================================================

  /** 「正被按住」的物理键，存 event.code，如 'KeyW'、'Space' */
  const held = new Set();

  /** 「这一帧刚按下」的动作名。每帧末尾清空，所以只在一帧内为真 */
  const pressed = new Set();

  /** 「这一帧刚松开」的动作名。同样每帧末尾清空 */
  const released = new Set();

  // --------------------------------------------------------------------------
  // 触屏"虚拟按键"（第二套输入源）
  // --------------------------------------------------------------------------
  /**
   * ★ 为什么需要单独一套集合，而不是复用上面的 held？★
   *
   * 上面那三个集合存的都是**物理键名**（'KeyW'、'Space'），
   * 必须先经过 KEYMAP 翻译才能变成游戏动作 —— 这套设计是为键盘量身定做的。
   *
   * 但触屏按钮不一样：它天然就是"上 / 下 / 攻击"这种**动作**，
   * 根本没有物理键名，也不需要那张映射表。硬塞进 held 还得反向编造一个假键名，
   * 非常别扭。所以干脆另开一套、直接存动作名的集合，查询时把两套合并。
   *
   * 最大的好处是：**游戏逻辑一行都不用改**。
   * 玩家和 game.js 问的永远是"上是不是被按住了"，
   * 它不关心你是用键盘敲的、还是用手指戳的。这叫"输入源可替换"。
   */
  const virtualHeld = new Set();    // 触屏正按住的动作
  const virtualPressed = new Set(); // 触屏这一帧刚按下的动作

  // ==========================================================================
  // 二、按键映射表
  // ==========================================================================

  /**
   * 物理键 → 游戏动作 的映射。
   *
   * ★ 为什么要这一层翻译？★
   * 如果游戏逻辑直接写 if (按住 'KeyW')，以后想支持自定义按键，
   * 就得满项目搜 'KeyW' 改一遍。有了映射表，游戏逻辑只问
   * "玩家是不是在按上"，改键只需改这张表，逻辑代码零改动。
   */
  const KEYMAP = {
    up:      ['KeyW', 'ArrowUp'],
    down:    ['KeyS', 'ArrowDown'],
    left:    ['KeyA', 'ArrowLeft'],
    right:   ['KeyD', 'ArrowRight'],
    attack:  ['KeyJ', 'Space'],
    confirm: ['Enter', 'NumpadEnter'],
  };

  /**
   * 反查表：物理键 → 动作名（如 'KeyW' → 'up'）。
   * 由下面的循环自动生成——手写容易漏，自动生成最可靠。
   */
  const codeToAction = {};
  for (const action in KEYMAP) {
    if (!Object.prototype.hasOwnProperty.call(KEYMAP, action)) continue;
    for (const code of KEYMAP[action]) codeToAction[code] = action;
  }

  /** 玩家是否已经按过任意键（用于解锁音频、隐藏提示条） */
  let anyKeyPressed = false;

  // ==========================================================================
  // 三、事件处理
  // ==========================================================================

  /** 按下键盘时触发 */
  function onKeyDown(e) {
    anyKeyPressed = true;

    // 阻止浏览器默认行为：空格/方向键默认是"滚动页面"，会干扰游戏
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.code)) {
      e.preventDefault();
    }

    // ★ 处理"按住不放"的自动重复 ★
    // 按住 W 超过约 0.5 秒后，系统会以每秒约 30 次的频率狂发 keydown。
    // 这是打字需要的，但对游戏是灾难：按住攻击键会变成每秒攻击 30 次。
    // e.repeat === true 表示"这是自动重复，不是新按下"，直接过滤。
    if (e.repeat) return;

    held.add(e.code);

    const action = codeToAction[e.code];
    if (action) pressed.add(action);
  }

  /** 松开键盘时触发 */
  function onKeyUp(e) {
    held.delete(e.code);

    const action = codeToAction[e.code];
    if (action) released.add(action);
  }

  /**
   * 清空所有按键状态。
   *
   * ★ 这个函数解决一个必然遇到的 bug ★
   * 玩家按住 D 往右跑时按了 Alt+Tab 切走，松开 D 的 keyup 事件
   * 被别的窗口截走了，我们收不到。于是 held 里永远留着 'KeyD'，
   * 切回来发现角色自己在跑，停不下来。
   * 所以：窗口一失焦，就把所有键当成"全松开了"。
   */
  function clearAll() {
    held.clear();
    pressed.clear();
    released.clear();
    virtualHeld.clear();
    virtualPressed.clear();
  }

  /** 把监听器挂到 window 上（挂 canvas 上需要先点击才生效，太麻烦） */
  function init() {
    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearAll);

    // 移动端切到后台也清空，避免虚拟按键卡住
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) clearAll();
    });
  }

  // ==========================================================================
  // 四、对外查询接口
  // ==========================================================================

  /** 某个动作这一帧是否被按住（持续型） */
  function isHeld(action) {
    // ★ 先查触屏 ★
    // 触屏的动作名在 KEYMAP 里往往没有对应条目（比如 'attack' 有，
    // 但虚拟按键也可能传进别的自定义动作），所以必须在查 KEYMAP 之前
    // 就先判一次，否则会被下面的 `if (!codes) return false` 提前挡掉。
    if (virtualHeld.has(action)) return true;

    const codes = KEYMAP[action];
    if (!codes) return false;
    // 这个动作绑了多个键，任一被按住就算激活
    for (let i = 0; i < codes.length; i++) {
      if (held.has(codes[i])) return true;
    }
    return false;
  }

  /** 某个动作这一帧是否"刚刚按下"（一次性，不会连发） */
  function isPressed(action) {
    return pressed.has(action) || virtualPressed.has(action);
  }

  /** 某个动作这一帧是否"刚刚松开" */
  function isReleased(action) {
    return released.has(action);
  }

  /**
   * 把方向键转成二维向量。
   *
   * ★ 这个函数解决"斜向移动加速"问题 ★
   * 如果直接 dx=1, dy=1，那么斜向位移向量长度是 √2 ≈ 1.414，
   * 也就是斜着走比直着走快 41%，竞技游戏里这是可以被利用的 bug。
   * 正确做法是"归一化"：把向量长度压成 1，八个方向速度才一致。
   *
   * @returns {{x:number, y:number}} 长度是 0（没按键）或 1（已归一化）
   */
  function getMoveVector() {
    let x = 0;
    let y = 0;

    if (isHeld('left'))  x -= 1;
    if (isHeld('right')) x += 1;
    if (isHeld('up'))    y -= 1;
    if (isHeld('down'))  y += 1;

    if (x === 0 && y === 0) return { x: 0, y: 0 };

    // 归一化：除以向量长度（勾股定理 √(x²+y²)）
    const len = Math.sqrt(x * x + y * y);
    return { x: x / len, y: y / len };
  }

  // ==========================================================================
  // 五、每帧收尾
  // ==========================================================================

  /**
   * ★ 每帧结束时必须调用 ★
   *
   * 一帧的执行顺序：
   *   1. 玩家按下 Enter（keydown 事件随时可能插入）
   *   2. 游戏逻辑读 isPressed('confirm') → true，开始游戏 ✓
   *   3. 本帧逻辑全部跑完
   *   4. 调用 endFrame() 清空 pressed / released  ← 你在这里
   *
   * 如果不清理会怎样？
   * 按键会永久留在集合里。玩家按下一次 Enter 之后，
   * 后面每一帧 isPressed('confirm') 都返回 true，
   * 游戏就会在"标题→游戏中→..."之间疯狂跳转。
   *
   * 注意只清 pressed/released，**不能清 held**——
   * held 要一直保留到 keyup 真正到来为止。
   */
  function endFrame() {
    pressed.clear();
    released.clear();
    virtualPressed.clear(); // 触屏的"刚按下"也一起清，理由同上
  }

  // ==========================================================================
  // 六、触屏按键注入（让虚拟按钮"假装"成键盘）
  // ==========================================================================

  /**
   * 模拟"按下"某个动作。由触屏手柄的按钮调用，比如：
   *     DG.Input.press('up')      // 约等于玩家按住了 W / ↑
   *     DG.Input.press('attack')  // 约等于玩家按下了 J / 空格
   *
   * 反复用同一个动作名调用是安全的：Set 天然去重。
   * 所以手指按住不动、事件反复触发时也不会出问题（这叫"幂等"）。
   *
   * @param {string} action 动作名，和 KEYMAP 里的键保持一致
   */
  function pressVirtual(action) {
    if (!action) return;
    anyKeyPressed = true;       // 触屏也算"玩家已经操作过了"（用来隐藏提示条）
    virtualHeld.add(action);
    virtualPressed.add(action); // 一次按下 = 这一帧的一次"边缘触发"
  }

  /**
   * 模拟"松开"某个动作。
   *
   * ★ 注意：这里**只删 held，不删 pressed** ★
   * "刚按下"这个信息必须在本帧内一直有效，交给 endFrame() 统一清理。
   * 如果在这儿也把它删掉，会出现"明明点到了、游戏却毫无反应"的诡异现象 ——
   * 因为 pointerdown 和 pointerup 有可能落到同一帧里
   * （手指轻点约 50ms，而一帧只有 16.7ms，但浏览器的事件派发和 rAF 并非严格对齐）。
   */
  function releaseVirtual(action) {
    if (!action) return;
    virtualHeld.delete(action);
  }

  // ==========================================================================
  // 七、暴露接口
  // ==========================================================================

  DG.Input = {
    init: init,
    isHeld: isHeld,
    isPressed: isPressed,
    isReleased: isReleased,
    getMoveVector: getMoveVector,
    endFrame: endFrame,
    clearAll: clearAll,

    /** 触屏按钮专用：按下 / 松开某个动作（详见本文件第六节） */
    press: pressVirtual,
    release: releaseVirtual,

    /** 玩家是否已经按过任意键（只读属性，用 get 语法暴露） */
    get anyKeyPressed() {
      return anyKeyPressed;
    },
  };

})(window.DG);
