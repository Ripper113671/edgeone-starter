/*
  ============================================================================
  文件：src/game.js —— 游戏主控（把所有零件组装成一台能跑的机器）
  ============================================================================

  【这个文件是干嘛的？】
  前面几个文件都是"零件"：
    config.js   参数表
    audio.js    音效
    input.js    键盘
    art.js      美术数据
    sprites.js  渲染引擎
    font.js     字体
    dungeon.js  地图生成
    entities.js 玩家/敌人/道具

  这个文件是"总装车间"：它决定这些零件什么时候按什么顺序运转起来。

  【你会学到什么？—— 三个游戏开发的核心机制】

  ★★ 机制 1：固定时间步长主循环（Fixed Timestep Game Loop）★★

  这是整个游戏的心脏。它的形状是这样的：

      每帧被浏览器调用一次：
          记下"距离上次已经过了多久"，加进累加器
          只要累加器 >= 1/60 秒：
              执行一次物理更新（固定 1/60 秒的量）
              累加器减去 1/60 秒
          把画面画出来

  **为什么不能直接在 rAF 回调里更新一次？**

  因为 requestAnimationFrame 的间隔是**不稳定**的：
    - 60Hz 屏幕 → 每 16.7ms 一次
    - 144Hz 屏幕 → 每 6.9ms 一次
    - 卡顿一下 → 可能变成 50ms 一次

  如果我们每次回调都"前进一点点"，那么在高刷屏上游戏会快 2.4 倍，
  卡顿时角色会瞬移。而"累加器"方案把不规律的真实时间
  切成一个个**固定长度**的逻辑片，物理计算永远稳定。

  这个方案是所有商业游戏引擎的标准做法。

  ★★ 机制 2：状态机（State Machine）★★

  游戏在不同阶段做不同的事：
    TITLE       → 只响应回车
    FLOOR_INTRO → 只倒计时，不响应操作
    PLAYING     → 正常玩
    GAMEOVER    → 只响应回车

  如果用 if/else 硬写，条件会越堆越乱。用状态机之后，
  每帧开头一个 switch，逻辑清清楚楚，每个分支里的事情互不干扰。

  ★★ 机制 3：深度排序（Depth Sorting / Y-Sorting）★★

  在俯视角游戏里，谁挡住谁是**由 y 坐标决定的**：
  y 越小（越靠屏幕上方）的东西越"远"，应该先画（被后面画的盖住）；
  y 越大（越靠下方）的东西越"近"，应该后画（盖住前面的）。

  所以渲染前要把所有角色按 y 排个序，再依次画出来。
  没有这一步，就会出现"角色走到敌人身后却还画在敌人前面"的穿帮。

  【阅读建议】
  先读最下面的 loop()（主循环），搞清楚"每帧发生什么"，
  再回到 update() 和 render() 看细节。这是理解一个游戏代码最有效的顺序。
  ============================================================================
*/

(function (DG) {
  'use strict';

  // ★ 三个容易搞混的名字，先在这里说清楚 ★
  //   TILE          —— 瓦片"类型"枚举（TILE.WALL / TILE.FLOOR / TILE.STAIRS）
  //   DG.TILE_SIZE  —— 一个瓦片"多少像素"（16）
  //   ST            —— 游戏状态枚举（ST.TITLE / ST.PLAYING ...）
  //
  // 凡是做"格数 ↔ 像素数"换算的地方，一律写全 DG.TILE_SIZE，
  // 这样一眼就能看出这里是在换算尺寸，而不是在判断类型。
  const TILE = DG.TILE;
  const P = DG.PALETTE;
  const ST = DG.STATE;

  // ==========================================================================
  // 一、初始化画布
  // ==========================================================================

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  // 主画布也要关掉平滑，否则 drawImage 放大贴图时会糊
  ctx.imageSmoothingEnabled = false;

  /**
   * 把画布等比放大到合适的大小。
   *
   * ★ 为什么要手算缩放，不用 CSS 的 width: 100%？★
   * 因为 CSS 拉伸到非整数倍（比如 1.37 倍）会让像素大小不均匀 ——
   * 有些像素占 1 个屏幕像素，有些占 2 个，画面会出现"摩尔纹"般的锯齿感。
   * 只用**整数倍**缩放，每个游戏像素都变成整齐的 N×N 方块，才是干净的像素画面。
   *
   * 所以这里算出"能塞得下的最大整数倍"，再手动设置 style 的宽高。
   */
  function resizeCanvas() {
    const marginX = 40;   // 左右留白
    const marginY = 96;   // 上下留白（底部还要放提示条）

    const availW = window.innerWidth - marginX;
    const availH = window.innerHeight - marginY;

    // 取宽高两个方向都能满足的那个倍数（所以用 min）
    let scale = Math.min(availW / DG.VIEW_W, availH / DG.VIEW_H);

    // 向下取整到整数倍。但至少要 1 倍，否则小窗口里会缩得看不见
    scale = Math.max(1, Math.floor(scale));

    canvas.style.width = (DG.VIEW_W * scale) + 'px';
    canvas.style.height = (DG.VIEW_H * scale) + 'px';

    // ★ 缩放变化后必须重新关闭平滑 ★
    // 因为改变 canvas 的 CSS 尺寸会影响浏览器的采样方式，
    // 有些浏览器会在重排后重置这个标志，所以再设一次保险。
    ctx.imageSmoothingEnabled = false;
  }

  // ==========================================================================
  // 二、光照用的离屏画布
  // ==========================================================================

  /**
   * 光照画布：先在它上面画一片"黑暗"，再在玩家位置"擦"出一个洞，
   * 最后整张盖到主画布上，就有了"火把照亮周围"的效果。
   *
   * ★ 为什么光照能大幅提升观感？★
   * 因为它制造了**未知**。玩家看不到远处的房间，
   * 只能一点点探索 —— 这正是地牢游戏的核心体验。
   * 如果全图可见，"探索"就变成了"看地图"，紧张感全没了。
   *
   * 另外，视觉焦点会自动被亮的地方吸引，
   * 光照还能顺便帮玩家把注意力锁定在角色周围，减少画面杂乱感。
   */
  const lightCanvas = DG.Sprites.makeCanvas(DG.VIEW_W, DG.VIEW_H);
  const lightCtx = lightCanvas.getContext('2d');

  /**
   * 小地图画布：尺寸 = 地图格数（60×40），所以 1 个格子正好 1 个像素。
   * 尺寸会在 buildMinimap() 里根据实际地图重新设置。
   */
  const minimapCanvas = DG.Sprites.makeCanvas(1, 1);
  const minimapCtx = minimapCanvas.getContext('2d');
  minimapCtx.imageSmoothingEnabled = false;

  /**
   * 记录"小地图当前画的是哪张地图"。
   *
   * ★ 用对象引用做比较是这里的关键技巧 ★
   * 每次换层，dungeon.generate() 都会返回一个**全新的** map 对象，
   * 所以只要 `minimapMapRef !== map` 就说明换层了，需要重画小地图。
   *
   * 这样就不用额外维护一个"需要重画吗"的布尔开关 ——
   * 少一个需要手动同步的状态，就少一个会忘记同步的 bug。
   */
  let minimapMapRef = null;

  /**
   * ★ 探索迷雾数据（"这片地我到底来没来过"）★
   *
   * 这是一个和地图等长的一维数组（排布方式和 map.tiles 完全一样），
   * 每格只存 0 或 1：
   *     0 = 还没走到过（小地图上留黑）
   *     1 = 已经探索过（小地图上画出来）
   *
   * 用 Uint8Array 而不是普通数组，理由和 dungeon.js 里一样：
   * 2400 个格子每格只占 1 字节，又快又省。
   *
   * ★ 它只增不减 ★
   * 走过的地方就是走过了，不会因为玩家离开而重新变黑。
   * 这正是"探索"的意义：把走过的地方变成已知，永久留在小地图上。
   */
  let explored = null;

  /** 当前这份探索数据属于哪张地图（换层就作废重来） */
  let exploredMapRef = null;

  /** 小地图的缓存是不是"脏"了，需要在下一帧重画（见 renderMinimap） */
  let minimapDirty = false;

  /**
   * 上一次算探索时，玩家站在哪个格子里。
   * ★ 这只是个性能小优化 ★
   * 玩家一秒钟最多移动 5 格左右，但主循环每秒要跑 60 次。
   * 记住"上次在哪格"，只有**跨格**时才重新计算，能省掉 90% 的无效循环。
   */
  let lastExploreTx = -1;
  let lastExploreTy = -1;

  // ==========================================================================
  // 三、游戏状态对象
  // ==========================================================================

  /**
   * 把整个游戏的运行时状态装进一个对象。
   *
   * ★ 为什么不散着写几十个全局变量？★
   * 因为"重开一局"会变得极其麻烦 —— 你得记得把每一个变量都重置，
   * 漏掉一个就出现"新游戏里分数是上次的"这种 bug（而且很常见）。
   *
   * 全装进一个对象后，重开就是"重建这个对象"，干净利落。
   */
  const game = {
    state: ST.TITLE,     // 当前状态
    map: null,           // 当前楼层地图
    player: null,        // 玩家实体
    enemies: [],         // 敌人列表
    items: [],           // 道具列表
    particles: [],       // 粒子列表
    projectiles: [],     // 投射物列表（法师的火球）

    // ---- 选人相关 ----
    charIndex: 0,                  // 选人界面上光标停在哪个角色（数组下标）
    charId: DG.CHARACTERS[0].id,   // 已经确定下来的角色 id，开局后不再改变

    // ---- 数据统计 ----
    floor: 1,            // 当前层数
    score: 0,            // 总分
    coins: 0,            // 捡了几个金币
    kills: 0,            // 杀了几个敌人
    runTime: 0,          // 本局玩了多久（秒）

    // ---- 相机（就是"镜头"）----
    // 它记录的是"当前画面左上角对应世界坐标系的哪个点"。
    // 想让玩家居中，就令 camX = 玩家x - 半屏宽。
    camX: 0,
    camY: 0,

    // ---- 计时器 ----
    introTimer: 0,       // 楼层提示还剩多久消失
    blinkTimer: 0,       // 通用闪烁计时（"按回车开始"那种）
    shakeX: 0,           // 本帧的屏幕震动偏移
    shakeY: 0,
  };

  // ==========================================================================
  // 三之二、历史最高分（存进浏览器，关掉页面也还在）
  // ==========================================================================

  /**
   * ★ localStorage 是什么？★
   *
   * 它是浏览器提供的一个"小仓库"，可以按"键 → 值"存字符串，
   * 而且**关掉浏览器再打开还在**（内存里的变量早就没了）。
   * 容量一般 5MB 左右，存一行成绩绰绰有余。
   *
   * ★ 为什么必须用 try / catch 包着？★
   * 因为它并不总是可用：
   *   · 用户开了隐私 / 无痕模式 → 部分浏览器直接禁用
   *   · 直接双击打开 file:// 页面 → 一些浏览器会限制它
   *   · 存储空间满了 → 写入会抛错
   * 不捕获的话，游戏会在"存档"那一行直接崩掉 ——
   * 而"记不记分"这种小事，绝对不该让整个游戏挂掉。
   * 这就是"非关键功能必须能优雅降级"的思路。
   */
  const BEST_KEY = 'pixel_dungeon_best_v1';

  /** 历史最好成绩。给全默认值，保证第一次玩（还没有存档）时也能正常读 */
  let best = { score: 0, floor: 0, kills: 0 };

  /** 本局是不是破了纪录（结算画面要专门显示一行 "NEW RECORD!"） */
  let newRecord = false;

  /** 从浏览器仓库里读出历史最高分。启动时调用一次 */
  function loadBest() {
    try {
      const raw = window.localStorage.getItem(BEST_KEY);
      if (!raw) return; // 第一次玩，没有存档，保持默认的 0

      const data = JSON.parse(raw);
      if (data && typeof data.score === 'number') {
        best.score = data.score || 0;
        best.floor = data.floor || 0;
        best.kills = data.kills || 0;
      }
    } catch (err) {
      // 读失败不是问题：无非是这次不显示最高分，游戏照常能玩
      console.warn('[Best] 读取最高分失败（隐私模式或 file:// 下可能出现）：', err);
    }
  }

  /** 把历史最高分写回浏览器仓库 */
  function saveBest() {
    try {
      window.localStorage.setItem(BEST_KEY, JSON.stringify(best));
    } catch (err) {
      console.warn('[Best] 保存最高分失败：', err);
    }
  }

  /**
   * 一局结束时结算：如果这局打得比历史最好还好，就更新并保存。
   * 只在"玩家死亡"那一刻调用一次。
   */
  function updateBest() {
    newRecord = game.score > best.score;
    if (!newRecord) return;

    best.score = game.score;
    best.floor = game.floor;
    best.kills = game.kills;
    saveBest();
  }

  // ==========================================================================
  // 四、开局与换层
  // ==========================================================================

  /**
   * 开始新的一局。
   *
   * @param {string} charId 用哪个角色开局（由选人界面传进来）
   */
  function startRun(charId) {
    // 记住这一局用的是谁。loadFloor 每次换层都要靠它把玩家重新造出来。
    if (charId) game.charId = charId;

    // 重置所有统计
    game.floor = 1;
    game.score = 0;
    game.coins = 0;
    game.kills = 0;
    game.runTime = 0;
    game.blinkTimer = 0;
    newRecord = false; // 新的一局，还没破纪录

    // 生成第一层
    loadFloor(1);

    game.state = ST.FLOOR_INTRO;
    game.introTimer = 1.4;

    DG.Audio.play('start');
    hideHint();
  }

  /**
   * 加载第 n 层。
   *
   * ★ 这个函数把"换层"变成了一件极其简单的事 ★
   * 生成新地图 → 重建玩家 → 重建敌人和道具。
   * 因为所有状态都在一个 map 对象和一个数组里，
   * 直接整个替换就行，不需要小心翼翼地"清理"旧数据。
   */
  function loadFloor(n) {
    // ---- 生成地图 ----
    game.map = DG.Dungeon.generate(n);

    // ---- 创建玩家 ----
    // 每次都重新创建，好处是血量、状态自动是全新的；
    // 坏处是血量会被重置 —— 所以我们手动把血量带过来（见下）。
    const stats = DG.getCharacter(game.charId);

    const prevHp = game.player ? game.player.hp : stats.maxHp;
    const maxHp = game.player ? game.player.maxHp : stats.maxHp;

    // ★ 第三个参数把"这一局用哪个角色"传进去 ★
    // 换层时传的是同一个 id，所以整局下来角色不会中途换人。
    game.player = new DG.Player(game.map.spawn.x, game.map.spawn.y, game.charId);
    game.player.hp = prevHp;   // 保留上一层的血量（换层不回血，这是 roguelike 的惯例）
    game.player.maxHp = maxHp;
    game.player.sprite = game.charId + '_down_a';

    // ---- 创建敌人 ----
    game.enemies = [];
    game.map.enemySpawns.forEach(function (s) {
      game.enemies.push(new DG.Enemy(s.x, s.y, s.type, n));
    });

    // ---- 创建道具 ----
    game.items = [];
    game.map.itemSpawns.forEach(function (s) {
      game.items.push(new DG.Item(s.x, s.y, s.type));
    });

    // ---- 清空粒子和投射物（上一层的东西不该跟过来）----
    game.particles = [];
    game.projectiles = [];

    // ---- 相机立刻瞬移到玩家身上 ----
    // ★ 注意这里是"瞬移"而不是"平滑跟随"★
    // 如果让相机从上一层的旧位置慢慢飘过来，玩家会看到画面横穿整个地图，
    // 非常晕。换层这种"场景切换"时刻，相机必须瞬间到位。
    // 这是一个很重要的区分：什么时候该平滑，什么时候该瞬移。
    snapCamera();
  }

  /** 让相机瞬间对准玩家（不做平滑） */
  function snapCamera() {
    game.camX = game.player.x - DG.VIEW_W / 2;
    game.camY = game.player.y - DG.VIEW_H / 2;
    clampCamera();
  }

  /** 把相机限制在地图范围内，防止看到地图外面的虚空 */
  function clampCamera() {
    const worldW = game.map.w * DG.TILE_SIZE;
    const worldH = game.map.h * DG.TILE_SIZE;

    // 上界：世界尺寸 - 视口尺寸。若世界比视口还小，就固定在 0。
    const maxX = Math.max(0, worldW - DG.VIEW_W);
    const maxY = Math.max(0, worldH - DG.VIEW_H);

    game.camX = DG.clamp(game.camX, 0, maxX);
    game.camY = DG.clamp(game.camY, 0, maxY);
  }

  /**
   * 平滑跟随玩家。
   *
   * ★ 用指数收敛而不是固定速度 ★
   *   t = 1 - e^(-speed × dt)
   * 这个公式保证任何帧率下相机的收敛速度都一样，
   * 而且速度越快收得越急、快到位时自动变慢，看起来非常自然。
   *
   * 如果直接用 camX += (target - camX) * 0.1，帧率一变跟随速度就变了，
   * 又掉进"帧率相关 bug"的坑里。
   */
  function updateCamera(dt) {
    const FOLLOW_SPEED = 11; // 每秒收敛的"强度"，越大跟得越紧
    const t = 1 - Math.exp(-FOLLOW_SPEED * dt);

    const targetX = game.player.x - DG.VIEW_W / 2;
    const targetY = game.player.y - DG.VIEW_H / 2;

    game.camX = DG.lerp(game.camX, targetX, t);
    game.camY = DG.lerp(game.camY, targetY, t);

    clampCamera();
  }

  /**
   * 处理屏幕震动。
   *
   * ★ 屏幕震动是"打击感"最廉价的来源 ★
   * 玩家受伤、敌人被打死时，让画面抖个几像素，玩家的"身体"会感觉到冲击。
   * 实现成本几乎为零，但效果拔群。
   *
   * ★ 关键：震动幅度必须快速衰减 ★
   * 如果震动持续太久，画面会变成"一直在抖"，玩家很快就会晕。
   * 好的震动应该只有 0.1~0.2 秒，短到玩家甚至意识不到发生了什么，
   * 但身体记住了"刚才那下很疼"。
   */
  function updateShake(dt) {
    if (DG.shakeAmount > 0.2) {
      // 随机方向抖动
      game.shakeX = DG.randFloat(-DG.shakeAmount, DG.shakeAmount);
      game.shakeY = DG.randFloat(-DG.shakeAmount, DG.shakeAmount);
      // 快速衰减
      DG.shakeAmount *= Math.pow(0.0005, dt);
    } else {
      DG.shakeAmount = 0;
      game.shakeX = 0;
      game.shakeY = 0;
    }
  }

  /**
   * 点亮玩家周围的"探索迷雾"。
   *
   * ★ 这个函数解决的是"小地图剧透"问题 ★
   *
   * 游戏主体有光照：你看不清远处的房间，只能一点点摸黑探索。
   * 但小地图如果一上来就把整张地图（含楼梯在哪）全画出来，
   * 那"探索"就退化成"看地图"了 —— 两个系统自相矛盾。
   *
   * 解决办法：小地图只画**玩家真正走到过**的地方。
   * 走过的路会永久留在小地图上，没去过的房间始终是黑的。
   * 这样小地图就从"作弊器"变回了"探索记录仪"，和光照的意图一致了。
   *
   * 实现上就是：以玩家所在格为圆心，把半径 EXPLORE_RADIUS 内的格子标成 1。
   * 每帧只判断一次，而且只在玩家"跨格"时才真的去算（见上面的 lastExploreTx）。
   */
  function updateExploration() {
    const map = game.map;

    // ---- 换层了：探索数据作废，重新开一张空白的 ----
    // 用对象引用比较来判断，和 minimapMapRef 是同一个套路：
    // generate() 每次返回的都是全新对象，所以引用一变就说明换层了。
    if (exploredMapRef !== map) {
      explored = new Uint8Array(map.w * map.h);
      exploredMapRef = map;
      minimapDirty = true;
      lastExploreTx = -1; // 置成不可能的值，强制下面立刻重算一次
      lastExploreTy = -1; // （这样新地图的出生点周围会马上被点亮）
    }

    // ★ 用 Math.floor 而不是 Math.round ★
    // 像素 0~15 都属于第 0 格，所以要向下取整。
    // 若用 round，玩家站在格子正中心（x = 格号 + 0.5）时会被进位到下一格，
    // 小地图上的白点就会偶发地跳一格 —— 这就是典型的 off-by-one 错误。
    const ptx = Math.floor(game.player.x / DG.TILE_SIZE);
    const pty = Math.floor(game.player.y / DG.TILE_SIZE);

    // 还在原来那一格里，什么都没变，直接返回（省掉下面上百次循环）
    if (ptx === lastExploreTx && pty === lastExploreTy) return;
    lastExploreTx = ptx;
    lastExploreTy = pty;

    const R = DG.LEVEL.EXPLORE_RADIUS;
    const r2 = R * R; // 提前把半径的平方算好，循环里就不用反复乘
    let changed = false;

    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        // ★ 用"距离平方"判断圆形范围，而不是开根号 ★
        // dx²+dy² <= R² 和 √(dx²+dy²) <= R 完全等价，
        // 但省掉了每个格子一次开方。这是图形学里很常见的小优化。
        if (dx * dx + dy * dy > r2) continue;

        const tx = ptx + dx;
        const ty = pty + dy;
        if (!map.inBounds(tx, ty)) continue; // 越界跳过

        const i = map.idx(tx, ty);
        if (explored[i]) continue; // 早就亮过了，不用重复标记

        explored[i] = 1;
        changed = true;
      }
    }

    // 有新格子被点亮 → 小地图缓存过期，下一帧要重画
    if (changed) minimapDirty = true;
  }

  // ==========================================================================
  // 五、更新逻辑
  // ==========================================================================

  /**
   * 逻辑更新入口。由主循环以固定 1/60 秒的步长调用。
   *
   * ★ 注意这里用的是 switch 而不是 if-else 链 ★
   * switch 的语义更明确："现在处于哪个状态，就做哪个状态的事"。
   * 而且以后加新状态（比如暂停、商店）只要加一个 case，不用担心条件顺序。
   */
  function update(dt) {
    // 通用计时器，所有状态都要走
    game.blinkTimer += dt;

    switch (game.state) {
      // ------------------------------------------------------------------
      // 标题画面：只等玩家按回车
      // ------------------------------------------------------------------
      case ST.TITLE:
        if (DG.Input.isPressed('confirm')) {
          // ★ 不再直接开局，而是先进选人界面 ★
          game.state = ST.CHAR_SELECT;
          game.blinkTimer = 0;
          DG.Audio.play('blip');
        }
        break;

      // ------------------------------------------------------------------
      // 选人界面：左右挑角色，按攻击键 / 回车确定
      // ------------------------------------------------------------------
      case ST.CHAR_SELECT:
        chooseCharacter();
        break;

      // ------------------------------------------------------------------
      // 楼层提示：倒计时几秒，然后进入正常游玩
      // ------------------------------------------------------------------
      case ST.FLOOR_INTRO:
        game.introTimer -= dt;
        // 提示期间也允许玩家移动（但是怪不动），这样玩家不会觉得"卡住了"
        updatePlayer(dt);
        updateExploration(); // 玩家动过了，同步点亮小地图
        updateCamera(dt);
        updateShake(dt);
        updateParticles(dt);

        if (game.introTimer <= 0) {
          game.state = ST.PLAYING;
        }
        break;

      // ------------------------------------------------------------------
      // 正常游玩：完整的更新流程
      // ------------------------------------------------------------------
      case ST.PLAYING:
        game.runTime += dt;

        updatePlayer(dt);
        updateExploration(); // 玩家动过了，同步点亮小地图
        updateEnemies(dt);
        updateItems(dt);
        // ★ 投射物必须排在 resolveCombat 之前 ★
        // 这样它本帧飞到的新位置，本帧就能参与命中判定，不会慢一帧。
        // 顺序错了会出现"火球明明穿过了敌人却没打中"的玄学 bug。
        updateProjectiles(dt);
        updateParticles(dt);
        resolveCombat(dt);
        checkStairs();
        updateCamera(dt);
        updateShake(dt);

        // 死亡检查放在最后 —— 这样本帧的所有逻辑都正常执行完，
        // 不会出现"血扣了但伤害特效没播"的半截状态
        if (game.player.hp <= 0) {
          game.state = ST.GAMEOVER;
          game.blinkTimer = 0; // 重置计时，保证"按回车重开"有 0.6 秒冷却（防输入穿透）
          DG.Audio.play('gameover');
          DG.shakeAmount = 8;

          // ★ 结算成绩 ★
          // 放在"确定死亡"之后、画面开始渲染之前，
          // 这样 renderGameOver() 里读到的 newRecord 一定是最新值。
          updateBest();
        }
        break;

      // ------------------------------------------------------------------
      // 游戏结束：等玩家按回车重开
      // ------------------------------------------------------------------
      case ST.GAMEOVER:
        updateShake(dt);
        updateParticles(dt);

        // 加一个小延迟再接受输入。
        // ★ 为什么要这个延迟？★
        // 玩家死前的最后一击很可能正按着空格（攻击键），
        // 如果不加延迟，那一瞬间按下的回车/空格会被当成"重开"，
        // 玩家还没看清分数就进了新一局。这种 bug 叫"输入穿透"，
        // 在游戏 UI 里非常常见，加个 0.5 秒冷却就能解决。
        if (game.blinkTimer > 0.6 && DG.Input.isPressed('confirm')) {
          game.blinkTimer = 0; // 重置，避免下次立刻触发

          // ★ 回到选人界面，而不是立刻重开 ★
          // 死了之后十有八九想换个角色再试一把；
          // 如果直接重开，玩家还得先去找地方死一次才能换人，很蠢。
          // "让玩家少按一次键"是 UI 改进里回报率最高的那种。
          game.state = ST.CHAR_SELECT;
          DG.Audio.play('blip');
        }
        break;
    }
  }

  /** 更新玩家 */
  function updatePlayer(dt) {
    const p = game.player;
    p.update(dt, game.map, DG.Input);

    // ★ 远程角色的开火时机 ★
    // 玩家在 update 里只是"申请开火"（把 pendingShot 置为 true），
    // 真正把火球塞进世界这件事交给这里做 ——
    // 因为 Player 不该知道 game.projectiles 的存在，那是"游戏世界"的事。
    if (p.pendingShot) {
      p.pendingShot = false;
      spawnProjectile(p);
    }
  }

  /**
   * 选人界面的输入处理。
   *
   * 左右循环切换，攻击键或回车确认。
   *
   * ★ 这里用的是 isPressed 而不是 isHeld ★
   * isPressed 只在"刚按下那一帧"为真，所以按住左键不会疯狂滚动。
   * 想要"按住连滚"得另外实现长按重复 —— 那是给几百项的长列表准备的交互，
   * 四个选项用一下按一下反而更精确、更容易停在想停的位置。
   */
  function chooseCharacter() {
    const n = DG.CHARACTERS.length;

    if (DG.Input.isPressed('left')) {
      // ★ 先 +n 再取模 ★
      // 为了处理"在第一个角色上继续往左，绕回最后一个"。
      // 若直接写 (0 - 1) % n，JS 会算出 -1，拿去当数组下标就炸了 ——
      // 这是取模运算在负数上的经典陷阱，几乎所有语言都一样。
      game.charIndex = (game.charIndex + n - 1) % n;
      DG.Audio.play('blip');
    }

    if (DG.Input.isPressed('right')) {
      game.charIndex = (game.charIndex + 1) % n;
      DG.Audio.play('blip');
    }

    if (DG.Input.isPressed('attack') || DG.Input.isPressed('confirm')) {
      DG.Audio.play('start');
      startRun(DG.CHARACTERS[game.charIndex].id);
    }
  }

  /**
   * 生成一枚法师的火球。
   *
   * @param {Object} p 玩家实体
   */
  function spawnProjectile(p) {
    const S = p.stats;
    const dir = p.getFacingVector();

    // 出生点往前推 7 像素，免得火球一出来就贴着自己的脸
    const ox = p.x + dir.x * 7;
    const oy = p.y + dir.y * 7 - 2; // -2 是视觉上的"从胸口飞出"

    game.projectiles.push(new DG.Projectile(
      ox, oy,
      dir.x * S.shotSpeed,
      dir.y * S.shotSpeed,
      S.shotDamage,
      S.shotRange
    ));

    // 出手时炸一小簇紫光，让"发射"这个动作有实感
    DG.spawnBurst(ox, oy, 4, P.batB, 50, game.particles);
  }

  /** 更新所有投射物（倒序删除，理由同 updateParticles） */
  function updateProjectiles(dt) {
    const list = game.projectiles;
    for (let i = list.length - 1; i >= 0; i--) {
      list[i].update(dt, game.map);
      if (list[i].dead) list.splice(i, 1);
    }
  }

  /**
   * 更新所有敌人。
   *
   * ★ 注意两个容易漏掉的细节 ★
   *
   * 1. 倒序遍历删除
   *    如果正序遍历并在循环中 splice(i, 1) 删除元素，
   *    后面的元素会往前挪一格，导致**跳过**一个元素没处理。
   *    倒序遍历可以避免这个问题（删除不影响还没遍历到的部分）。
   *    这是 JS 里最经典的坑之一。
   *
   * 2. 先更新再清理
   *    先让所有敌人更新（这样它们能看到完整的"其他敌人"列表），
   *    全部更新完再统一删掉死亡的，避免"死掉的敌人还在影响别人"。
   */
  function updateEnemies(dt) {
    const list = game.enemies;
    const player = game.player;

    // ---- 先更新 ----
    for (let i = 0; i < list.length; i++) {
      list[i].update(dt, game.map, player, list);
    }

    // ---- 再统一清理死亡的 ----
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].dead) {
        list.splice(i, 1);
      }
    }
  }

  /** 更新道具（只是做浮动动画，没有 AI） */
  function updateItems(dt) {
    for (let i = 0; i < game.items.length; i++) {
      game.items[i].update(dt);
    }
  }

  /** 更新粒子（倒序删除，理由同上） */
  function updateParticles(dt) {
    const list = game.particles;
    for (let i = list.length - 1; i >= 0; i--) {
      list[i].update(dt);
      if (list[i].dead) list.splice(i, 1);
    }
  }

  // ==========================================================================
  // 六、战斗判定
  // ==========================================================================

  /**
   * 结算这一帧的所有碰撞：
   *   ① 玩家的剑有没有砍到敌人
   *   ② 敌人有没有撞到玩家
   *   ③ 玩家有没有捡到道具
   *
   * ★ 为什么把这些放在一个函数里？★
   * 因为它们都属于"本帧的位置都更新完了，现在来结算碰撞"这一件事。
   * 全部集中在一起，顺序一目了然，也方便调试时插入断点。
   */
  function resolveCombat(dt) {
    const player = game.player;

    // 玩家的碰撞盒转成矩形，方便做相交判断
    const playerBox = {
      x: player.x - player.hw,
      y: player.y - player.hh,
      w: player.hw * 2,
      h: player.hh * 2,
    };

    // ----------------------------------------------------------------------
    // ① 玩家的剑砍到谁了
    // ----------------------------------------------------------------------
    if (player.attacking) {
      const atkBox = player.getAttackBox();
      const S = player.stats;

      for (let i = 0; i < game.enemies.length; i++) {
        const e = game.enemies[i];

        // ★ 这一击已经打过它了，跳过 ★
        // 没有这一句，一击会造成十几帧的连续伤害（见 entities.js 里的解释）
        if (player.hitThisSwing.has(e)) continue;

        const eBox = {
          x: e.x - e.hw,
          y: e.y - e.hh,
          w: e.hw * 2,
          h: e.hh * 2,
        };

        if (!DG.Collision.rectsOverlap(atkBox, eBox)) continue;

        // ---- 命中！----
        player.hitThisSwing.add(e); // 记账，这一击不再打它

        // ★ 伤害来自角色配置，不再是全局常量 ★
        // 狂战士一刀 3 点、游侠一刀 1 点，四个角色的差别就体现在这一个数上。
        // 判定框的大小（atkW/atkH）则决定了"狂战士一刀能扫到几个"。
        hurtEnemy(e, S.atkDamage, player.x, player.y, S.knockbackMul, P.white);
      }
    }

    // ----------------------------------------------------------------------
    // ② 敌人撞到玩家了吗
    // ----------------------------------------------------------------------
    for (let i = 0; i < game.enemies.length; i++) {
      const e = game.enemies[i];
      if (e.dead) continue; // 已经死了的不该再造成伤害

      const eBox = {
        x: e.x - e.hw,
        y: e.y - e.hh,
        w: e.hw * 2,
        h: e.hh * 2,
      };

      if (!DG.Collision.rectsOverlap(playerBox, eBox)) continue;

      // takeDamage 内部会检查无敌帧，所以这里可以直接调用，
      // 不用自己判断"是不是还在无敌中"——把规则放在该管的那个类里，
      // 调用方就不用重复实现一遍。这叫做"把不变量封装在内部"。
      const hurt = player.takeDamage(e.damage, e.x, e.y);

      if (hurt) {
        // 受伤时炸红粒子，强化反馈
        DG.spawnBurst(player.x, player.y - 4, 8, P.red, 110, game.particles);
      }
    }

    // ----------------------------------------------------------------------
    // ③ 玩家捡到道具了吗
    // ----------------------------------------------------------------------
    for (let i = game.items.length - 1; i >= 0; i--) {
      const it = game.items[i];

      const itBox = {
        x: it.x - it.hw,
        y: it.y - it.hh,
        w: it.hw * 2,
        h: it.hh * 2,
      };

      if (!DG.Collision.rectsOverlap(playerBox, itBox)) continue;

      // ---- 捡到了 ----
      if (it.type === 'coin') {
        game.coins++;
        game.score += 5;
        DG.spawnBurst(it.x, it.y, 5, P.gold, 70, game.particles);
        DG.Audio.play('coin');
      } else if (it.type === 'potion') {
        const healed = player.heal(3);
        // ★ 满血时不该白白浪费一个血瓶 ★
        // 如果玩家满血，就让他先别捡，血瓶留在地上。
        // 这种"体贴玩家"的细节，是游戏品质的重要组成部分。
        if (healed <= 0) continue;

        DG.spawnBurst(it.x, it.y, 8, P.pink, 80, game.particles);
        DG.Audio.play('potion');
      }

      game.items.splice(i, 1); // 从列表里移除
    }

    // ----------------------------------------------------------------------
    // ④ 火球有没有打到人
    // ----------------------------------------------------------------------
    // ★ 为什么单独写一段，不和 ① 合并？★
    // 因为两者的判定形状根本不同：
    //   近战 —— 一个"跟着角色走的矩形"，比的是矩形的相交
    //   火球 —— 一个"独立飞行的小点"，比的是点到矩形的距离
    // 硬合并只会让代码既难读又容易出 bug，不如分开写得清清楚楚。
    for (let i = game.projectiles.length - 1; i >= 0; i--) {
      const pr = game.projectiles[i];

      // 上一帧已经炸掉的（撞墙、或飞到头了），顺手清理掉
      if (pr.dead) {
        game.projectiles.splice(i, 1);
        continue;
      }

      let hitSomething = false;

      for (let j = 0; j < game.enemies.length; j++) {
        const e = game.enemies[j];
        if (e.dead) continue;

        // 简化判定：横竖两个方向都靠得够近，就算打中。
        // 火球很小、敌人也不大，这种"近似圆形"的判定完全够用，
        // 而且比精确的圆-矩形相交快得多（省掉一次开平方）。
        if (Math.abs(pr.x - e.x) > e.hw + 3) continue;
        if (Math.abs(pr.y - e.y) > e.hh + 3) continue;

        // 火球的击退故意调弱（0.6）：不然法师能隔着半个屏幕把怪推着走，
        // 近战角色就彻底没活路了。
        hurtEnemy(e, pr.damage, pr.x, pr.y, 0.6, P.batB);

        hitSomething = true;
        break; // 一枚火球只打一个人，打完就消失
      }

      if (hitSomething) game.projectiles.splice(i, 1);
    }
  }

  /**
   * ★ 对某个敌人结算一次伤害 ★
   *
   * 近战和火球都走这个函数。抽出来的最大好处是：
   * **"击杀之后要加分、掉落、播特效、震屏"这整套流程只写了一遍**。
   *
   * 如果让近战和火球各写一份，早晚会出现"用火球打死怪不加分"这类
   * 只有玩家才能发现的诡异 bug —— 因为两条代码路径的细节总会慢慢飘开。
   *
   * @param {Object} e          被打的敌人
   * @param {number} amount     基础伤害
   * @param {number} fromX      伤害来自哪里（决定击退方向）
   * @param {number} fromY
   * @param {number} knockMul   击退倍率（1 = 标准）
   * @param {string} sparkColor 打击火花的颜色
   * @returns {boolean} 是否打死了
   */
  function hurtEnemy(e, amount, fromX, fromY, knockMul, sparkColor) {
    const killed = e.takeDamage(amount, fromX, fromY);

    // 击退微调：战士推得远、游侠推得近，这是"手感差异"的重要一环
    if (knockMul && knockMul !== 1) {
      e.kx *= knockMul;
      e.ky *= knockMul;
    }

    // 打击火花：几粒碎屑从敌人身上炸开
    DG.spawnBurst(e.x, e.y - 4, 5, sparkColor || P.white, 90, game.particles);

    if (killed) {
      // ---- 击杀 ----
      game.kills++;
      game.score += e.score;

      // 死亡时炸出一大团血花 + 屏幕震动
      DG.spawnBurst(e.x, e.y - 4, 12, P.red, 130, game.particles);
      DG.spawnBurst(e.x, e.y - 4, 6, P.redD, 100, game.particles);
      DG.shakeAmount = Math.max(DG.shakeAmount, 3);

      DG.Audio.play('kill');

      // ---- 掉落 ----
      const drop = e.getDrop();
      if (drop) {
        game.items.push(new DG.Item(e.x, e.y, drop));
      }
    } else {
      DG.Audio.play('hit');
      DG.shakeAmount = Math.max(DG.shakeAmount, 2);
    }

    return killed;
  }

  /** 检查玩家有没有踩到楼梯 */
  function checkStairs() {
    const tx = DG.pxToTile(game.player.x);
    const ty = DG.pxToTile(game.player.y);

    if (game.map.get(tx, ty) !== TILE.STAIRS) return;

    // ---- 进入下一层 ----
    game.floor++;
    game.score += 50; // 下楼奖励，鼓励探索
    loadFloor(game.floor);

    game.state = ST.FLOOR_INTRO;
    game.introTimer = 1.4;
    DG.Audio.play('stairs');
  }

  // ==========================================================================
  // 七、渲染
  // ==========================================================================

  /** 渲染入口 */
  function render() {
    // ---- 清屏 ----
    ctx.fillStyle = P.ink;
    ctx.fillRect(0, 0, DG.VIEW_W, DG.VIEW_H);

    if (game.state === ST.TITLE) {
      renderTitle();
      return;
    }

    // ★ 选人界面是"独立一屏"，和标题一样直接返回 ★
    // 它不需要画游戏世界，也不需要光照和小地图。
    if (game.state === ST.CHAR_SELECT) {
      renderCharSelect();
      return;
    }

    // ---- 画世界 ----
    renderWorld();

    // ---- 画光照 ----
    renderLighting();

    // ---- 画界面 ----
    renderHUD();

    // ---- 状态相关的覆盖层 ----
    if (game.state === ST.FLOOR_INTRO) renderFloorIntro();
    if (game.state === ST.GAMEOVER) renderGameOver();
  }

  /**
   * 画游戏世界（地图 + 角色 + 粒子）。
   */
  function renderWorld() {
    const map = game.map;
    const camX = game.camX;
    const camY = game.camY;

    // ----------------------------------------------------------------------
    // ★ 视锥剔除（Frustum Culling）★
    //
    // 地图有 60×40 = 2400 个格子，但屏幕只能显示 20×12 = 240 个。
    // 如果每帧把 2400 个格子都画一遍，90% 的绘制是白费的，
    // 而且完全看不见。所以先算出"哪些格子在屏幕范围内"，只画那些。
    //
    // 这是所有渲染引擎的第一条优化规则：**不要画看不见的东西**。
    // ----------------------------------------------------------------------
    const x0 = Math.max(0, Math.floor(camX / DG.TILE_SIZE) - 1);
    const y0 = Math.max(0, Math.floor(camY / DG.TILE_SIZE) - 1);
    const x1 = Math.min(map.w - 1, Math.ceil((camX + DG.VIEW_W) / DG.TILE_SIZE) + 1);
    const y1 = Math.min(map.h - 1, Math.ceil((camY + DG.VIEW_H) / DG.TILE_SIZE) + 1);

    // ---- 画地块 ----
    // ★ 为什么放在两层循环外面统一 translate？★
    // 如果用 ctx.translate 移动，所有坐标都变成"相对相机"的，
    // 就不用每个格子都手动减 camX 了。这是 Canvas 变换的典型用法。
    //
    // 但要注意：translate 会影响后续所有绘制，所以一定要 save/restore 配对着用。
    ctx.save();
    ctx.translate(
      Math.round(-camX + game.shakeX),
      Math.round(-camY + game.shakeY)
    );

    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const type = map.get(tx, ty);

        // 虚空不画（地图外围），否则会是一片黑格子干扰视觉
        if (type === TILE.VOID) continue;

        const img = DG.Sprites.getTile(type, tx, ty);
        if (img) {
          // ★ 这里没有取整 ★
          // 因为 tx * DG.TILE_SIZE 本身就是整数（tx 是整数，瓦片边长是 16），
          // 乘出来必然是整数，不用多此一举。
          ctx.drawImage(img, tx * DG.TILE_SIZE, ty * DG.TILE_SIZE);
        }
      }
    }

    // ----------------------------------------------------------------------
    // ★ 深度排序 ★
    // 把玩家、敌人、道具全部收集到一个列表里，按"脚底 y"排序后再画。
    // 见文件头的"机制 3"。
    // ----------------------------------------------------------------------
    const drawList = [];

    // 道具
    for (let i = 0; i < game.items.length; i++) {
      const it = game.items[i];
      drawList.push({
        y: it.y,
        sprite: it.sprite,
        x: it.x,
        // 道具浮动：getSpriteBottomY 再加一个正弦偏移
        bottomY: it.y + it.hh + it.getBobOffset(),
        flash: 0,
      });
    }

    // 敌人
    for (let i = 0; i < game.enemies.length; i++) {
      const e = game.enemies[i];
      // ★ 受击白闪的优先级 ★
      // 如果正在白闪，就把整只怪画成纯白剪影；
      // 否则画正常精灵。三目运算符在这里比 if-else 更紧凑。
      drawList.push({
        y: e.y,
        sprite: e.sprite,
        x: e.x,
        bottomY: e.getSpriteBottomY(),
        flash: e.hitFlash > 0 ? P.white : 0,
      });
    }

    // 玩家
    const p = game.player;
    const playerVisible = !p.isFlashing(); // 无敌闪烁时有些帧不显示
    if (playerVisible) {
      drawList.push({
        y: p.y,
        sprite: p.sprite,
        x: p.x,
        bottomY: p.getSpriteBottomY(),
        // 无敌时给玩家一个红色剪影，提示"我现在处于无敌状态"
        flash: p.invuln > 0 ? P.red : 0,
      });
    }

    // ★ 排序：y 小的先画（先画的会被后画的盖住）★
    // 这就是"越靠下越靠前"的俯视角遮挡关系。
    drawList.sort(function (a, b) {
      return a.y - b.y;
    });

    // 依次绘制
    for (let i = 0; i < drawList.length; i++) {
      const d = drawList[i];
      const spr = DG.Sprites.get(d.sprite);
      if (!spr) continue;

      const drawX = d.x - spr.w / 2;
      const drawY = d.bottomY - spr.h;

      if (d.flash) {
        // 用剪影方式画（受击白闪 / 无敌红闪）
        DG.Sprites.drawFlash(ctx, spr, drawX, drawY, d.flash);
      } else {
        DG.Sprites.draw(ctx, spr, drawX, drawY);
      }
    }

    // ---- 画挥击特效 ----
    // ★ 远程角色不画刀光 ★
    // 法师要是也在脸前挥出一道白光，就和"发射火球"这个动作自相矛盾了。
    if (p.attacking && !p.stats.ranged) renderSwing(p);

    // ---- 画火球 ----
    renderProjectiles();

    // ---- 画粒子 ----
    renderParticles();

    ctx.restore(); // 恢复坐标系（和上面的 save 配对）
  }

  /**
   * 画所有飞行中的投射物（火球）。
   *
   * ★ 火球是"发光体"，所以用同心方块 + 加法混合来画 ★
   *
   * 'lighter'（加法混合）的意思是：新画的颜色会**加到**底下的颜色上，
   * 而不是把底下的盖掉。红叠红 = 更亮的红，红叠白 = 白。
   * 这样叠两层就能自然画出"中间白热、外圈发光"的效果，
   * 完全不需要做透明度渐变 —— 这是像素游戏里画发光的标准手法。
   */
  function renderProjectiles() {
    for (let i = 0; i < game.projectiles.length; i++) {
      const pr = game.projectiles[i];
      const x = Math.round(pr.x);
      const y = Math.round(pr.y);

      // 脉动：火球自己一亮一暗，看起来是"活"的，而不是一颗静止的球
      const pulse = 0.72 + 0.28 * Math.sin(pr.animT * 24);

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = pulse;

      // 外焰（紫）
      ctx.fillStyle = P.batB;
      ctx.fillRect(x - 3, y - 3, 6, 6);

      // 内芯（近白），画在正中间
      ctx.fillStyle = P.white;
      ctx.fillRect(x - 1, y - 1, 2, 2);

      // ★ 千万别忘了 restore ★
      // globalCompositeOperation 是会"黏"在画笔上的状态。
      // 不恢复的话，后面画的粒子、UI 全都会变成加法混合，画面会糊成一片白。
      ctx.restore();
    }
  }

  /**
   * 画挥剑的刀光。
   *
   * ★ 这个特效完全是代码算出来的，没有用任何图片 ★
   *
   * 原理：让一道亮条从"起始角度"扫到"结束角度"。
   *   prog  = 挥剑进度（0 → 1）
   *   sweep = 把进度映射到 -1 ~ +1，表示亮条往侧面偏了多少
   *
   * 于是亮条会从角色左侧扫到右侧（或从上扫到下），
   * 看起来就是"刀挥过去了"。
   *
   * 这就是游戏开发里"用一个变量驱动动画"的思路：
   * 与其设计一堆关键帧，不如找一个能连续变化的量，然后映射到位置上。
   */
  function renderSwing(p) {
    const S = p.stats;
    const prog = 1 - (p.attackTimer / S.atkDuration); // 0（刚开始）→ 1（结束）
    const sweep = (prog - 0.5) * 2;                   // -1 → +1

    const dir = p.getFacingVector();
    const horizontal = (p.facing === 'left' || p.facing === 'right');

    // ★ 刀光的长度和粗细也跟着武器走 ★
    // 狂战士的巨斧又长又粗、游侠的短剑又短又细。
    // 这样玩家不看数值面板，光看挥砍特效就能知道自己手里拿的是什么。
    const LEN = Math.round(S.atkReach + 3);
    const THICK = (S.atkW >= 22) ? 3 : 2;

    // ★ 刀光会"变细" ★
    // 刚出手时最粗，收招时变细并消失。
    // 这个"宽度变化"让挥剑有了加速度感 —— 如果宽度恒定，
    // 看起来就像一根棍子在平移，很呆板。
    const width = Math.max(1, Math.round(THICK * (1 - prog * 0.6)));

    // 起始点：从角色中心往外一点，并加上扫动偏移
    let sx, sy;
    if (horizontal) {
      sx = p.x + dir.x * 3;
      sy = p.y - 3 + sweep * 5;
    } else {
      sx = p.x - 3 + sweep * 5;
      sy = p.y + dir.y * 3;
    }

    ctx.save();

    // 外层光晕（半透明），让刀光有"发光"的感觉。
    // ★ 颜色改用角色专属色 ★ —— 斧头是橙的、短剑是绿的，一眼能分辨。
    ctx.globalAlpha = 0.35 * (1 - prog);
    ctx.fillStyle = S.tint;
    if (horizontal) {
      ctx.fillRect(sx - THICK, sy - 2, LEN + 4, width + 3);
    } else {
      ctx.fillRect(sx - 2, sy - THICK, width + 3, LEN + 4);
    }

    // 内层刀身（亮白），是刀光的"实体"
    ctx.globalAlpha = 1 - prog * 0.5;
    ctx.fillStyle = P.white;
    if (horizontal) {
      ctx.fillRect(sx, sy, LEN, width);
    } else {
      ctx.fillRect(sx, sy, width, LEN);
    }

    ctx.restore();
  }

  /** 画粒子 */
  function renderParticles() {
    for (let i = 0; i < game.particles.length; i++) {
      const pt = game.particles[i];
      const alpha = pt.getAlpha();

      ctx.globalAlpha = alpha;
      ctx.fillStyle = pt.color;
      ctx.fillRect(
        Math.round(pt.x),
        Math.round(pt.y),
        pt.size,
        pt.size
      );
    }
    ctx.globalAlpha = 1; // ★ 一定要恢复 ★ 否则后面画的所有东西都会变透明
  }

  /**
   * 画光照。
   *
   * 步骤：
   *   1. 在光照画布上铺一层深色半透明遮罩
   *   2. 用 destination-out 混合模式，在玩家位置"擦"出一个圆形透光区
   *      （destination-out 的效果是"去掉已有像素"，就像用橡皮擦）
   *   3. 把这张画布盖到主画布上
   *   4. 再叠一层暖色光晕，模拟火把的暖光
   *
   * ★ 用径向渐变而不是硬边圆圈 ★
   * 硬边圆圈看起来像是"手电筒照了个洞"，很假。
   * 径向渐变从中心到边缘平滑过渡，才像真实的火光衰减。
   */
  function renderLighting() {
    const p = game.player;

    // 玩家在屏幕上的位置（世界坐标 - 相机坐标）
    const screenX = p.x - game.camX;
    const screenY = p.y - game.camY - 4; // 稍微上移，对准身体而不是脚

    // ---- 第 1 步：铺遮罩 ----
    // ★ 透明度是"探索感"和"可玩性"之间的旋钮 ★
    //   调太低（比如 0.3）→ 全图都能看清，"探索"变成"看地图"，紧张感消失
    //   调太高（比如 0.85）→ 只能看见脚下一小块，走路变成盲人摸象，非常烦躁
    // 0.62 是反复试出来的平衡点：远处能隐约看出轮廓（暗示"那边有路"），
    // 但看不清细节（保持未知感）。
    lightCtx.globalCompositeOperation = 'source-over';
    lightCtx.clearRect(0, 0, DG.VIEW_W, DG.VIEW_H);
    lightCtx.fillStyle = 'rgba(4, 4, 12, 0.62)';
    lightCtx.fillRect(0, 0, DG.VIEW_W, DG.VIEW_H);

    // ---- 第 2 步：擦出玩家周围的透光区 ----
    lightCtx.globalCompositeOperation = 'destination-out';

    // ★ 用两层光，而不是一层 ★
    // 只画一层"明亮的圆"的话，圆的边界会非常突兀，
    // 玩家能明显看到一条"光的圆圈"，很出戏。
    //
    // 加一层大而微弱的光（半径 190，强度只有 0.22），
    // 就相当于给整个画面加了一个柔和的过渡区 ——
    // 从"很亮"渐变成"有点亮"再渐变成"暗"，非常自然。
    // 这是游戏光照最常用的"主光 + 环境光"双层做法。
    eraseLight(lightCtx, screenX, screenY, 190, 0.22); // 环境光（大而弱）
    eraseLight(lightCtx, screenX, screenY, 118, 1);    // 主光（小而强）

    // 楼梯光源：半径小一点、弱一点，作为"目标指引"
    // ★ 这是个很重要的可玩性设计 ★
    // 如果楼梯完全在黑暗中，玩家只能靠地毯式搜索，非常枯燥。
    // 给楼梯一点微光，玩家就能远远瞥见"那边有东西"，探索立刻有了方向感。
    const stX = (game.map.stairs.x + 0.5) * DG.TILE_SIZE - game.camX;
    const stY = (game.map.stairs.y + 0.5) * DG.TILE_SIZE - game.camY;
    if (stX > -80 && stX < DG.VIEW_W + 80 && stY > -80 && stY < DG.VIEW_H + 80) {
      eraseLight(lightCtx, stX, stY, 58, 0.8);
    }

    // ---- 第 3 步：盖到主画布上 ----
    lightCtx.globalCompositeOperation = 'source-over';
    ctx.drawImage(lightCanvas, 0, 0);

    // ---- 第 4 步：叠加暖色火光 ----
    // 用 'lighter' 混合模式（加法混合）：新颜色和老颜色相加。
    // 加法混合天然适合做"发光"效果，因为它只会让画面变亮，不会变暗。
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const glow = ctx.createRadialGradient(screenX, screenY, 0, screenX, screenY, 62);
    glow.addColorStop(0, 'rgba(255, 170, 80, 0.14)');
    glow.addColorStop(0.5, 'rgba(220, 120, 50, 0.06)');
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, DG.VIEW_W, DG.VIEW_H);
    ctx.restore();
  }

  /**
   * 在光照画布上"擦"出一个柔和的圆。
   *
   * @param {CanvasRenderingContext2D} c 光照画布的画笔
   * @param {number} x 圆心
   * @param {number} y
   * @param {number} radius 半径
   * @param {number} strength 强度（0~1），1 表示中心完全透光
   */
  function eraseLight(c, x, y, radius, strength) {
    const grad = c.createRadialGradient(x, y, 0, x, y, radius);

    // ★ 渐变的关键在于"中间几步"★
    // 只有两个色标（0 和 1）的话，亮度会线性衰减，看起来像一圈均匀的光环。
    // 加了中间的色标之后，可以做出一段"亮度基本不变"的核心区，
    // 再快速衰减到边缘 —— 这才像真实光源的样子。
    grad.addColorStop(0, 'rgba(0,0,0,' + strength + ')');
    grad.addColorStop(0.45, 'rgba(0,0,0,' + (strength * 0.88) + ')');
    grad.addColorStop(0.72, 'rgba(0,0,0,' + (strength * 0.45) + ')');
    grad.addColorStop(1, 'rgba(0,0,0,0)');

    c.fillStyle = grad;
    c.beginPath();
    c.arc(x, y, radius, 0, Math.PI * 2);
    c.fill();
  }

  // ==========================================================================
  // 八、界面（HUD / 标题 / 结算）
  // ==========================================================================

  /** 画游戏中的信息界面 */
  function renderHUD() {
    const p = game.player;

    // ---- 左上角：生命值（一颗心 = 1 点血）----
    for (let i = 0; i < p.maxHp; i++) {
      const spr = DG.Sprites.get(i < p.hp ? 'heart_full' : 'heart_empty');
      if (!spr) continue;
      DG.Sprites.draw(ctx, spr, 4 + i * 8, 4);
    }

    // ---- 右上角：分数 ----
    const scoreText = '分数 ' + String(game.score).padStart(5, '0');
    const scoreW = DG.Font.measure(scoreText, 1);
    DG.Font.draw(ctx, scoreText, DG.VIEW_W - 4 - scoreW, 4, P.gold, 1);

    // ---- 右上角第二行：金币数 ----
    // ★ 第二行的 y 从 12 挪到了 18 ★
    // 因为中文字的行高是 12 像素，而原来的英文点阵字只有 5 像素高。
    // 继续用 12 的话，两行会直接贴在一起糊掉。
    // 换了字体就得重新排一遍版 —— 这是本地化工作里最容易被忽略的一步。
    const coinText = '金币 ' + String(game.coins).padStart(3, '0');
    const coinW = DG.Font.measure(coinText, 1);
    DG.Font.draw(ctx, coinText, DG.VIEW_W - 4 - coinW, 18, P.fire, 1);

    // ---- 顶部中间：层数 ----
    DG.Font.drawCentered(ctx, '第 ' + game.floor + ' 层', DG.VIEW_W / 2, 4, P.white, 1);

    // ---- 左下角：小地图（只在有地图时画）----
    renderMinimap();
  }

  /**
   * 画一个小地图。
   *
   * ★ 小地图在探索类游戏里几乎是必需品 ★
   * 如果没有它，玩家很容易在同一片区域反复绕圈 ——
   * 因为俯视角游戏里，走过和没走过的房间长得一模一样。
   * 小地图把"我探索了多少"变成一个可视的进度，玩家的目标感会强很多。
   *
   * 实现很简单：把地图按比例缩小，每 2~3 个格子画成一个像素点。
   * 地板画灰、墙留空、楼梯画青色、玩家画白点。
   */
  function renderMinimap() {
    const map = game.map;

    // ---- 预渲染地形缓存 ----
    // ★ 为什么要预渲染？★
    // 地图有 60×40 = 2400 格。如果每帧都遍历一遍画 2400 个 fillRect，
    // 一秒就是 14 万次绘制调用，白白浪费性能。
    // 所以把"地形 + 探索状态"一次性烤成一张小画布，之后每帧只要贴上去。
    // 又是"预计算换性能"这个思路 —— 和精灵烘焙、瓦片生成是同一个道理。
    //
    // ★ 什么时候需要重烤这张缓存？★
    // 两种时刻：① 换层了（整张地图都换了）
    //           ② 探索迷雾又多亮了几格（updateExploration 会把 minimapDirty 置位）
    // 第二种是**探索系统**带来的新情况：以前地形一成不变，
    // 现在它会随着玩家走动而慢慢"长出来"，所以缓存必须跟着更新。
    //
    // 每帧真正需要重画的只有那个代表玩家的小白点（因为它一直在动）。
    if (minimapMapRef !== map || minimapDirty) {
      buildMinimap(map);
      minimapMapRef = map;
      minimapDirty = false;
    }

    // 1 个地图格子 = 1 个屏幕像素（60×40 的小地图，右下角摆放）
    const ox = DG.VIEW_W - map.w - 4;
    const oy = DG.VIEW_H - map.h - 4;

    ctx.save();

    // 半透明黑底 + 边框，让地图能看清又不完全盖住游戏画面
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = P.ink;
    ctx.fillRect(ox - 1, oy - 1, map.w + 2, map.h + 2);
    ctx.globalAlpha = 1;

    // 贴上预渲染好的地形
    ctx.drawImage(minimapCanvas, ox, oy);

    // ---- 玩家位置：一个醒目的白点 ----
    // ★ 小地图上必须能看见自己 ★
    // 不显示玩家位置的地图等于没用 —— 玩家的第一反应永远是"我在哪？"
    // 所以用最大的对比度（纯白 3×3）来标记它。
    //
    // ★ 这里必须是 Math.floor ★
    // 像素 0~15 都属于第 0 格。若用 round，玩家正好站在格子中心
    // （x = 格号 + 0.5）时会被进位到下一格，白点就会偶发地偏一格。
    const ptx = Math.floor(game.player.x / DG.TILE_SIZE);
    const pty = Math.floor(game.player.y / DG.TILE_SIZE);

    // 先画一个深色外框，再画白点，这样即使在浅色地面上也看得清
    ctx.fillStyle = P.ink;
    ctx.fillRect(ox + ptx - 2, oy + pty - 2, 5, 5);
    ctx.fillStyle = P.white;
    ctx.fillRect(ox + ptx - 1, oy + pty - 1, 3, 3);

    ctx.restore();
  }

  /**
   * 把"地图 + 探索状态"预渲染到小地图画布上。
   *
   * ★ 关键变化：不再只是"每层做一次"★
   * 因为探索迷雾会随着玩家走动不断增加，
   * 所以只要有新格子被点亮，这张缓存就要重烤一次。
   */
  function buildMinimap(map) {
    // 画布尺寸 = 地图格数，所以 1 格正好 1 像素
    minimapCanvas.width = map.w;
    minimapCanvas.height = map.h;

    // ★ 注意：给 canvas 重新赋值 width/height 会清空整张画布，
    // 同时也会把画笔的状态（比如 imageSmoothingEnabled）重置回默认值。
    // 所以这两件事都得在这之后重新做一遍。★
    minimapCtx.imageSmoothingEnabled = false;

    // 先铺一层"未知区域的底色"（深色）。
    // 后面只有已探索的格子会被覆盖成亮色，剩下没碰到的自然就是黑色的"迷雾"。
    minimapCtx.fillStyle = P.ink;
    minimapCtx.fillRect(0, 0, map.w, map.h);

    // ★ 保险检查：这份探索数据必须属于"当前这张地图" ★
    // 换层后的那一瞬间，render 有可能先于 update 跑到这里来 ——
    // 因为 loop 虽然是"先 update 再 render"，但换层是在 update 的中途发生的，
    // 那一刻 explored 还指着**上一层**的数组。
    // 两张地图尺寸一样、索引又一一对应，不拦住的话，
    // 小地图会在换层的那一帧里"闪现"出上一层的探索形状。
    // 拦掉之后这一帧显示全黑 —— 而这恰恰是对的：新的一层本来就应该完全未知。
    if (!explored || exploredMapRef !== map) return;

    for (let ty = 0; ty < map.h; ty++) {
      for (let tx = 0; tx < map.w; tx++) {

        // ★★ 核心就这一行 ★★
        // 没探索过的格子直接跳过，保持深色。
        // 有它，小地图才会"慢慢长出来"，而不是一上来就剧透全图 ——
        // 这正是从"作弊器"变回"探索记录仪"的地方。
        if (!explored[map.idx(tx, ty)]) continue;

        const type = map.get(tx, ty);
        let color = null;

        if (type === TILE.STAIRS) {
          color = P.cyan;       // 楼梯用青色，是地图上最显眼的信息
        } else if (type === TILE.FLOOR) {
          // ★ 小地图上的地板要比真实地面亮 ★
          // 因为小地图是"信息图"而不是"画面"，
          // 在 1 像素一粒的尺度下，暗色几乎等于看不见。
          // 这里直接写死一个亮度更高的颜色，而不是复用 P.floorA。
          color = '#4a4a72';
        } else {
          continue;             // 墙和虚空不画，留黑（黑色背景自然就是"墙"）
        }

        minimapCtx.fillStyle = color;
        minimapCtx.fillRect(tx, ty, 1, 1);
      }
    }
  }

  /**
   * ★ 选人界面 ★
   *
   * 【布局设计】
   * 从上到下分三层：
   *   1. 标题
   *   2. 四张角色卡横排（选中那张会亮起来）
   *   3. 选中角色的详细资料 + 四根属性条
   *
   * ★ 为什么用"卡片列表 + 详情面板"，而不是把四份资料全塞进四张卡里？★
   * 因为 320 像素宽根本塞不下。硬塞的结果就是每张卡上的字都小到看不清。
   * 拆成"上面选人、下面看详情"之后，同一时刻只需要显示**一份**资料，
   * 空间立刻宽裕了 —— 这是小屏幕 UI 最常用、也最有效的妥协。
   */
  function renderCharSelect() {
    // ---- 背景 ----
    const bg = ctx.createLinearGradient(0, 0, 0, DG.VIEW_H);
    bg.addColorStop(0, '#15152e');
    bg.addColorStop(1, '#05050c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, DG.VIEW_W, DG.VIEW_H);

    const LIST = DG.CHARACTERS;

    // ---- 标题 ----
    DG.Font.drawCentered(ctx, '选择角色', DG.VIEW_W / 2, 10, P.gold, 2);

    // ---- 四张角色卡 ----
    const CARD_W = 60;
    const CARD_H = 62;
    const CARD_Y = 40;
    const GAP = 12;

    // 居中摆放：先算总宽，再算左边起点。
    // 这样以后加第五个角色，排版会自动重新居中，不用手动改数字。
    const totalW = LIST.length * CARD_W + (LIST.length - 1) * GAP;
    const startX = Math.round((DG.VIEW_W - totalW) / 2);

    for (let i = 0; i < LIST.length; i++) {
      const ch = LIST[i];
      const x = startX + i * (CARD_W + GAP);
      const selected = (i === game.charIndex);

      // 卡片底
      ctx.fillStyle = selected ? 'rgba(62, 58, 112, 0.92)' : 'rgba(24, 24, 42, 0.85)';
      ctx.fillRect(x, CARD_Y, CARD_W, CARD_H);

      // 边框：选中的用金色，没选中的用暗紫灰
      ctx.strokeStyle = selected ? P.gold : '#3a3960';
      ctx.lineWidth = 1;
      // +0.5 的偏移是为了让 1 像素的线正好落在像素格中间，不会发虚
      ctx.strokeRect(x + 0.5, CARD_Y + 0.5, CARD_W - 1, CARD_H - 1);

      // 角色立绘：用"面朝下"那一帧放大 2 倍
      const spr = DG.Sprites.get(ch.id + '_down_a');
      if (spr) {
        const dw = spr.w * 2;
        const dh = spr.h * 2;
        ctx.imageSmoothingEnabled = false;
        // 9 个参数的 drawImage：把原图的整块区域缩放画到目标位置。
        // 配合 imageSmoothingEnabled=false 就是最近邻放大，像素不会糊。
        ctx.drawImage(
          spr.canvas,
          0, 0, spr.w, spr.h,
          Math.round(x + (CARD_W - dw) / 2), CARD_Y + 5, dw, dh
        );
      }

      // 角色名
      DG.Font.drawCentered(
        ctx, ch.name, x + CARD_W / 2, CARD_Y + 43,
        selected ? P.gold : P.wallA, 1
      );
    }

    // ---- 详情面板 ----
    const ch = LIST[game.charIndex];

    // 职业 · 武器
    DG.Font.drawCentered(ctx, ch.role + '·' + ch.weapon, DG.VIEW_W / 2, 112, ch.tint, 1);

    // 一句话卖点
    DG.Font.drawCentered(ctx, ch.desc, DG.VIEW_W / 2, 128, P.white, 1);

    // ---- 四根属性条 ----
    // ★ 为什么用条形图，而不是直接写数字？★
    // 因为玩家"比较条形的长短"比"读四个数字再在脑子里比大小"快得多。
    // 尤其"速度 104"这种数字，单看完全没有尺度感，
    // 但画成条之后一眼就知道谁快谁慢。这是信息可视化的基本道理。
    const bars = [
      { label: '生命', value: ch.maxHp,     max: 8 },
      { label: '速度', value: ch.speed,     max: 110 },
      { label: '伤害', value: ch.atkDamage, max: 3 },
      // 攻速用"每秒能打几下"表示更直观：冷却越短，攻速越高。
      // 直接显示冷却秒数（0.15）玩家是没感觉的，取倒数才符合直觉。
      { label: '攻速', value: 1 / ch.atkCooldown, max: 1 / 0.15 },
    ];

    const BAR_W = 62;
    const BAR_Y = 160;
    const BAR_GAP = 13;

    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const bx = 16 + i * (BAR_W + BAR_GAP);

      DG.Font.drawCentered(ctx, b.label, bx + BAR_W / 2, 144, P.wallA, 1);

      // 槽（暗底）
      ctx.fillStyle = '#232238';
      ctx.fillRect(bx, BAR_Y, BAR_W, 5);

      // 填充（用角色自己的颜色）
      const ratio = DG.clamp(b.value / b.max, 0, 1);
      ctx.fillStyle = ch.tint;
      ctx.fillRect(bx, BAR_Y, Math.round(BAR_W * ratio), 5);
    }

    // ---- 底部操作提示 ----
    const blink = 0.5 + 0.5 * Math.sin(game.blinkTimer * 5);
    ctx.save();
    ctx.globalAlpha = 0.45 + blink * 0.55;
    DG.Font.drawCentered(ctx, '左右选择    J 键确定', DG.VIEW_W / 2, 176, P.white, 1);
    ctx.restore();
  }

  /** 标题画面 */
  function renderTitle() {
    // ---- 背景：一片深色，加一点竖向渐变的"光柱"感 ----
    const bg = ctx.createLinearGradient(0, 0, 0, DG.VIEW_H);
    bg.addColorStop(0, '#12122a');
    bg.addColorStop(1, '#05050c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, DG.VIEW_W, DG.VIEW_H);

    // ---- 标题 ----
    // 中文标题只有 4 个字，放大 3 倍后是 156×36，正好撑得起画面。
    // 原来英文要拆成 PIXEL / DUNGEON 两行才够气势，中文一行就够了。
    DG.Font.drawCentered(ctx, '像素地牢', DG.VIEW_W / 2, 30, P.gold, 3);
    DG.Font.drawCentered(ctx, '深入地底', DG.VIEW_W / 2, 72, P.fire, 1);

    // ---- 装饰：四角站上怪物，让画面不空 ----
    const slime = DG.Sprites.get('slime_a');
    const bat = DG.Sprites.get('bat_a');
    if (slime) {
      DG.Sprites.draw(ctx, slime, 26, DG.VIEW_H - 30);
      DG.Sprites.draw(ctx, slime, DG.VIEW_W - 36, DG.VIEW_H - 30);
    }
    if (bat) {
      DG.Sprites.draw(ctx, bat, 40, 18);
      DG.Sprites.draw(ctx, bat, DG.VIEW_W - 52, 18);
    }

    // ---- 历史最高分 ----
    // 第一次玩的玩家还没有纪录（best.score 是 0），这时什么都不显示，
    // 免得标题画面孤零零挂一行"最高分 00000"，反而显得莫名其妙。
    if (best.score > 0) {
      const bestText = '最高分 ' + String(best.score).padStart(5, '0');
      DG.Font.drawCentered(ctx, bestText, DG.VIEW_W / 2, 94, P.gold, 1);
    }

    // ---- 闪烁提示 ----
    // ★ 闪烁是"这里需要你操作"的通用视觉语言 ★
    // 玩家已经形成了条件反射：画面在闪 = 该按了。
    // 用 blinkTimer 取正弦，得到平滑的明暗呼吸感（比硬切换柔和）。
    const blink = 0.5 + 0.5 * Math.sin(game.blinkTimer * 5);

    ctx.save();
    ctx.globalAlpha = 0.45 + blink * 0.55;
    DG.Font.drawCentered(ctx, '按回车开始', DG.VIEW_W / 2, 116, P.white, 1);
    ctx.restore();

    // ---- 操作说明 ----
    DG.Font.drawCentered(ctx, '方向键移动   J 键攻击', DG.VIEW_W / 2, 146, P.wallA, 1);
    DG.Font.drawCentered(ctx, '找到楼梯，深入下一层', DG.VIEW_W / 2, 162, P.wallA, 1);
  }

  /** 换层时的"第 N 层"提示 */
  function renderFloorIntro() {
    // ★ 淡入淡出：让提示不是"突然出现又突然消失" ★
    // alpha 由 introTimer 算出来：开始时 0 → 快速淡入 → 保持 → 淡出
    const t = game.introTimer / 1.4; // 1 → 0
    let alpha;
    if (t > 0.75) {
      alpha = (1 - t) / 0.25;        // 开头 25% 时间淡入
    } else if (t < 0.3) {
      alpha = t / 0.3;               // 结尾 30% 时间淡出
    } else {
      alpha = 1;                     // 中间保持全亮
    }

    ctx.save();
    ctx.globalAlpha = DG.clamp(alpha, 0, 1);

    // 半透明遮罩，让文字更清晰
    ctx.fillStyle = 'rgba(8, 8, 18, 0.55)';
    ctx.fillRect(0, 0, DG.VIEW_W, DG.VIEW_H);

    // ★ 两行的间距被拉开了 ★
    // 中文字高 12 像素，而原来的英文点阵字只有 5 像素。
    // 沿用原来 -12 / +10 的间距，"第 3 层"和"祝你好运"会直接糊在一起。
    DG.Font.drawCentered(ctx, '第 ' + game.floor + ' 层', DG.VIEW_W / 2, DG.VIEW_H / 2 - 18, P.gold, 2);
    DG.Font.drawCentered(ctx, '祝你好运', DG.VIEW_W / 2, DG.VIEW_H / 2 + 12, P.wallA, 1);

    ctx.restore();
  }

  /** 游戏结束画面 */
  function renderGameOver() {
    // 逐渐加深的红色遮罩，营造"失败了"的氛围
    const t = Math.min(1, game.blinkTimer / 0.8);
    ctx.fillStyle = 'rgba(40, 6, 10, ' + (0.72 * t) + ')';
    ctx.fillRect(0, 0, DG.VIEW_W, DG.VIEW_H);

    DG.Font.drawCentered(ctx, '游戏结束', DG.VIEW_W / 2, 30, P.red, 3);

    // ---- 结算数据 ----
    // ★ 标签全部换成了四字词 ★
    // 不是为了好看，而是为了让左边的标签列宽度一致。
    // 中文标签长短不一时，右对齐的数值列会看起来参差不齐，很业余。
    const lines = [
      ['到达层数', String(game.floor)],
      ['击杀敌人', String(game.kills)],
      ['收集金币', String(game.coins)],
      ['总分', String(game.score)],
    ];

    let y = 84;
    lines.forEach(function (pair, i) {
      // 最后一行"总分"用金色并且放大，突出最重要的信息
      const isScore = (i === lines.length - 1);
      const color = isScore ? P.gold : P.white;
      const scale = isScore ? 2 : 1;

      DG.Font.draw(ctx, pair[0], 56, y, P.wallA, 1);
      // 数值右对齐，看起来整齐
      const vw = DG.Font.measure(pair[1], scale);
      DG.Font.draw(ctx, pair[1], DG.VIEW_W - 56 - vw, y - (isScore ? 4 : 0), color, scale);

      y += isScore ? 20 : 14;
    });

    // ---- 破纪录提示 ----
    // 塞在"结算数据"和"重开提示"之间的空档里（约 y=148），
    // 既不会挤到上面的成绩，也不会挡住下面的操作提示。
    if (newRecord) {
      const blinkRec = 0.5 + 0.5 * Math.sin(game.blinkTimer * 6);
      ctx.save();
      ctx.globalAlpha = 0.5 + blinkRec * 0.5;
      DG.Font.drawCentered(ctx, '新纪录！', DG.VIEW_W / 2, 148, P.gold, 1);
      ctx.restore();
    }

    // ---- 重开提示 ----
    const blink = 0.5 + 0.5 * Math.sin(game.blinkTimer * 5);
    ctx.save();
    ctx.globalAlpha = 0.4 + blink * 0.6;
    DG.Font.drawCentered(ctx, '按回车再战', DG.VIEW_W / 2, DG.VIEW_H - 22, P.white, 1);
    ctx.restore();
  }

  // ==========================================================================
  // 九、主循环
  // ==========================================================================

  /**
   * ★ 主循环 —— 整个游戏的心脏 ★
   *
   * requestAnimationFrame 会在"浏览器准备画下一帧"时调用这个函数，
   * 通常是每秒 60 次（高刷屏是 120/144 次）。它比 setInterval 好，
   * 因为标签页切到后台时它会自动暂停，不会浪费电。
   */
  let lastTime = 0;     // 上一次执行的时间戳（毫秒）
  let accumulator = 0;  // ★ 累加器 ★ 攒够了 1/60 秒就更新一次逻辑

  function loop(now) {
    // 请求下一帧（必须在函数开头或结尾调用，否则循环就停了）
    requestAnimationFrame(loop);

    // ---- 第一次运行：只记录时间，不更新 ----
    // 否则第一帧的 dt 会是"从页面加载到现在"的巨大值，
    // 导致累加器爆炸、疯狂补算物理。
    if (lastTime === 0) {
      lastTime = now;
      render();
      return;
    }

    // ---- 算出这一帧真实过了多久 ----
    let elapsed = (now - lastTime) / 1000; // 毫秒转秒
    lastTime = now;

    // ★ 时间上限保护 ★
    // 浏览器切标签页回来时，elapsed 可能是好几秒。
    // 如果不限制，后面会一次性补算几百次物理，游戏卡死几秒钟。
    // 直接把超过 0.25 秒的部分丢掉 —— 玩家不会察觉，但游戏不会卡。
    if (elapsed > 0.25) elapsed = 0.25;

    accumulator += elapsed;

    // ---- 按固定步长消耗累加器 ----
    let steps = 0;
    while (accumulator >= DG.DT && steps < DG.MAX_STEPS) {
      update(DG.DT);           // 用固定 1/60 秒更新逻辑
      DG.Input.endFrame();     // ★ 每步更新完要清理"一次性按键" ★
      accumulator -= DG.DT;
      steps++;
    }

    // ---- 绘制 ----
    // ★ 注意 render 每帧只调用一次，而不是每个逻辑步都调用 ★
    // 因为屏幕刷新率是固定的，中间那些逻辑步的画面玩家根本看不到，
    // 画了也是白画（还浪费性能）。这就是"更新频率和渲染频率解耦"。
    render();
  }

  // ==========================================================================
  // 十、启动
  // ==========================================================================

  /** 隐藏底部的操作提示条 */
  function hideHint() {
    const hint = document.getElementById('hint');
    if (hint) hint.classList.add('fade');
  }

  /**
   * 把触屏虚拟手柄的按钮接上事件。
   *
   * ★ 为什么用 pointerdown / pointerup，而不是 touchstart / click？★
   *
   *   click       —— 太慢。它要等"按下 + 抬起"都完成才触发，
   *                  而动作游戏需要的是"手指一碰到就立刻响应"。
   *   touchstart  —— 只支持触摸。pointer 事件是它的超集，
   *                  鼠标、触控笔、手指都能用，一套代码通吃。
   *   pointerdown —— ✓ 手指碰到按钮的那一刻**立刻**触发，正是我们要的时机。
   *
   * ★ setPointerCapture 是干嘛的？★
   * 默认情况下，如果手指从按钮上滑出去，pointerup 会派发给别的元素，
   * 按钮就收不到"抬起"了 —— 结果就是方向键一直"卡"在按下状态，
   * 角色自己往前跑个不停。setPointerCapture 相当于"这根手指我接管了"，
   * 之后无论它滑到哪，事件都还发给我，保证能收到抬起。
   * 这是移动端虚拟按键必须处理的经典问题。
   */
  function initTouchControls() {
    const root = document.getElementById('touch-controls');
    if (!root) return; // 页面里没有这一层（比如被删了）就安静跳过

    const buttons = root.querySelectorAll('[data-action]');

    /** 处理"按下" */
    function onDown(e) {
      const el = e.currentTarget;
      e.preventDefault(); // 阻止浏览器把这次触摸解释成滚动 / 双击缩放

      // 手指交互同样算"用户已操作"，正好借这个机会解锁音频 + 收起提示
      DG.Audio.unlock();
      hideHint();

      DG.Input.press(el.getAttribute('data-action'));
      el.classList.add('active'); // 高亮反馈

      if (el.setPointerCapture && e.pointerId !== undefined) {
        try {
          el.setPointerCapture(e.pointerId);
        } catch (err) {
          // 某些浏览器在特殊情况下会拒绝，忽略即可，不影响基本功能
        }
      }
    }

    /** 处理"抬起"（正常抬起 / 被系统取消，都要当成松手） */
    function onUp(e) {
      const el = e.currentTarget;
      e.preventDefault();
      DG.Input.release(el.getAttribute('data-action'));
      el.classList.remove('active');
    }

    for (let i = 0; i < buttons.length; i++) {
      const el = buttons[i];
      el.addEventListener('pointerdown', onDown);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp); // 被系统打断（来电、手势）时也要松手
      el.addEventListener('contextmenu', function (e) {
        e.preventDefault(); // 长按不要弹出右键菜单
      });
    }

    console.log('[Touch] 虚拟手柄已就绪（共 ' + buttons.length + ' 个按键）');
  }

  /**
   * 初始化游戏。
   * 由 main.js 在页面加载完成后调用。
   */
  function init() {
    // ---- 1. 读取历史最高分 ----
    // 放在最前面，这样标题画面第一帧就能把它显示出来
    loadBest();

    // ---- 2. 烘焙所有精灵和瓦片 ----
    DG.Sprites.init();

    // ---- 2.5 预热中文字形 ----
    // ★ 这一步在中文项目里几乎是必备的 ★
    // 中文字形是"拿系统字体现烤"出来的（原理见 font.js），
    // 第一次用到某个字要跑一次 fillText + getImageData，而 getImageData 相当慢。
    // 如果全留着"用到才烤"，第一次弹出"游戏结束"时会明显卡一下 ——
    // 偏偏那又是玩家最需要立刻看清成绩的时刻。
    // 把所有会用到的文案提前烤一遍，游戏过程就始终顺滑。
    DG.Font.warmUp([
      // ★ 这里直接抄"完整的原文案"，而不是把字拆散拼凑 ★
      // 拆散拼凑看着省事，但极容易漏字 —— 比如"最高分"里的"最"和"高"、
      // 句子里的全角逗号"，"，拆开之后很容易被忘掉；
      // 而漏掉的那个字会在游戏里第一次出现时卡一下。
      // 宁可多写几个字，也不要为了省事留个坑。
      '像素地牢', '深入地底', '按回车开始', '最高分',
      '选择角色', '左右选择', 'J', '键确定',
      '分数', '金币', '第', '层',
      '游戏结束', '到达层数', '击杀敌人', '收集金币', '总分',
      '新纪录！', '按回车再战',
      '方向键移动', 'J 键攻击', '找到楼梯，深入下一层', '祝你好运',
      // 四个角色的名字、职业、武器、卖点
      '大', '祖', '马', '金',
      '狂战士', '巨斧', '秘法师', '法杖', '游侠', '短剑', '圣骑士', '长剑',
      '横扫一片，一击退敌', '隔空放火，远程灼烧',
      '身法如风，出手极快', '重甲护身，受伤减免',
      // HUD 里每一局都会出现的数字
      '0123456789',
    ]);

    // ---- 3. 初始化键盘监听 ----
    DG.Input.init();

    // ---- 4. 初始化触屏虚拟手柄 ----
    // 桌面端不会显示这些按钮（CSS 用媒体查询挡掉了），
    // 但事件照常绑上，多的只是几个监听器，没有性能负担。
    initTouchControls();

    // ---- 5. 设置画布尺寸，并监听窗口变化 ----
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // ---- 6. 首次按键时解锁音频 ----
    // ★ 浏览器的自动播放限制要求必须由用户交互触发 ★（见 audio.js 的说明）
    // 用 { once: true } 让监听器只生效一次，之后自动移除，不留垃圾。
    //
    // 注意：触屏那条路径上没有 keydown 事件，
    // 所以它的解锁是在 initTouchControls() 的 onDown 里单独做的。
    window.addEventListener('keydown', function unlock() {
      DG.Audio.unlock();
      hideHint();
    }, { once: true });

    // ---- 7. 造一个玩家，只为让标题画面有东西可渲染 ----
    // 标题状态下其实用不到玩家，但 render() 里有些代码会访问 game.player，
    // 提前造一个能避免"读取 null 的属性"这种报错。
    game.player = new DG.Player(0, 0, game.charId);

    // ---- 8. 点火，开始跑主循环 ----
    console.log('[Game] 初始化完成，开始主循环');
    requestAnimationFrame(loop);
  }

  // 把需要被外部访问的东西挂出去
  DG.Game = {
    init: init,
    game: game,
    // 暴露这几个方便在浏览器控制台里调试，比如手动跳层、加血
    startRun: startRun,
    loadFloor: loadFloor,
  };

})(window.DG);
