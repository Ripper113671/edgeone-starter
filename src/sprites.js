/*
  ============================================================================
  文件：src/sprites.js —— 精灵渲染引擎（"字符画" → 真正的图片）
  ============================================================================

  【这个文件是干嘛的？】
  art.js 里那些字符串数组只是**数据**，浏览器并不认识它们。
  这个文件负责把数据"烤"（bake）成一张张真正的小图片，
  游戏运行时就可以像贴贴纸一样快速往画布上贴。

  【你会学到什么？】

  1. ★ 离屏画布（Offscreen Canvas）—— 这是性能优化的核心思想 ★

  假设我们不做预烘焙，每帧都重新解析字符画：
      for 每个像素: ctx.fillRect(x, y, 1, 1)
  一个 12×14 的角色有 168 个像素，30 个角色就是 5000 次 fillRect，
  每秒 60 帧 → 每秒 30 万次绘制调用。浏览器直接就卡死了。

  正确做法：**只在游戏启动时解析一次**，把结果画进一张
  "看不见的画布"（用 document.createElement('canvas') 创建，
  没有插进页面所以不显示）。之后每帧只需要一次 drawImage 把整张图贴上去。

  这就是"预计算 vs 实时计算"的典型权衡：
  用一次性启动开销，换来每帧的性能。游戏开发里到处是这种思路。

  2. 为什么所有坐标都要 Math.round？
     像素游戏里如果角色画在 x = 10.37 这个位置，
     浏览器会做抗锯齿，导致边缘像素糊掉、颜色变淡。
     取整之后每个像素都精准对齐到屏幕网格上，画面才锐利。
     这个小细节决定了"看起来专业"还是"看起来廉价"。

  3. 程序化生成瓦片（Procedural Tile）
     地板和墙不是画出来的，而是**用代码算出来的**。
     配合 config.js 里的 hash2d 函数，可以做出"看起来随机但每次一样"的纹理。

  【阅读建议】
  先看 bake()（核心），再看 init()（批量烘焙），最后看瓦片生成部分。
  ============================================================================
*/

(function (DG) {
  'use strict';

  const TILE = DG.TILE;
  const P = DG.PALETTE;

  // ==========================================================================
  // 一、底层工具
  // ==========================================================================

  /**
   * 创建一张离屏画布。
   *
   * ★ "离屏"是什么意思？★
   * 就是用 createElement 造一个 canvas 元素，但**从不把它加到页面里**。
   * 它在内存中存在、可以画东西、可以被 drawImage 读取，
   * 但用户永远看不见它本身。我们就用它当"临时画纸"。
   *
   * @param {number} w 宽（像素）
   * @param {number} h 高（像素）
   * @returns {HTMLCanvasElement}
   */
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  /**
   * 把一份字符画"烤"成一张离屏画布。
   *
   * ★ 这是整个文件的核心函数 ★
   *
   * 流程：
   *   1. 量出字符画多宽多高，造一张一样大的空白画布
   *   2. 逐行逐列扫描每个字符
   *   3. 查 CHARS 字典拿到颜色，用 fillRect 在这张画布上点一个 1×1 的像素
   *   4. 返回这张画好的画布
   *
   * @param {string[]} rows 字符画，比如 ['..kk..', '.kyyk.']
   * @returns {{canvas: HTMLCanvasElement, w: number, h: number, ox: number, oy: number}}
   *          ox/oy 是"视觉中心偏移"：因为角色脚下有留白，
   *          直接按几何中心对齐会显得角色"浮在半空"，所以要往下推一点。
   */
  function bake(rows) {
    const h = rows.length;         // 高度 = 有多少行
    const w = rows[0].length;      // 宽度 = 第一行有多少个字符

    // 检查所有行长度是否一致。这是个很值得做的防御性检查：
    // 手写字符画时最常见的错误就是某一行多打或少打一个字符，
    // 结果整个角色被拉伸得歪掉，而且特别难发现（肉眼看只是一点点歪）。
    for (let y = 0; y < h; y++) {
      if (rows[y].length !== w) {
        console.warn(
          '[Sprites] 字符画第 ' + y + ' 行宽度是 ' + rows[y].length +
          '，但第一行是 ' + w + '，请检查 art.js'
        );
      }
    }

    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');

    // ★ 关闭平滑：让 drawImage 缩放时不做模糊插值 ★
    // 对离屏画布同样要设，否则以后如果放大绘制会糊掉。
    ctx.imageSmoothingEnabled = false;

    for (let y = 0; y < h; y++) {
      const row = rows[y];
      for (let x = 0; x < w; x++) {
        const ch = row[x];
        const color = DG.ART.CHARS[ch];

        // 透明像素直接跳过，不画
        if (!color) continue;

        ctx.fillStyle = color;
        ctx.fillRect(x, y, 1, 1); // 一个字符 = 一个像素
      }
    }

    return { canvas: canvas, w: w, h: h };
  }

  /**
   * 把一张画布水平翻转，返回一张新的画布。
   *
   * ★ 为什么需要它？★
   * 玩家朝左和朝右其实是同一个角色，只是镜像关系。
   * 如果不做翻转，我们就得手画"朝左"和"朝右"两套精灵 —— 工作量翻倍，
   * 而且以后改角色形象还要改两处，非常容易改漏。
   *
   * 翻转的实现只用了三个变换操作（这就是 Canvas 2D 的"变换矩阵"）：
   *   translate(w, 0) → 把坐标原点挪到右上角
   *   scale(-1, 1)    → 把 x 轴翻转（-1 表示反向）
   *   drawImage       → 画进去，结果是镜像的
   *
   * @param {{canvas: HTMLCanvasElement, w: number, h: number}} spr
   * @returns 翻转后的精灵
   */
  function flipH(spr) {
    const canvas = makeCanvas(spr.w, spr.h);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    ctx.translate(spr.w, 0); // 原点移到右上
    ctx.scale(-1, 1);        // x 方向镜像
    ctx.drawImage(spr.canvas, 0, 0);

    return { canvas: canvas, w: spr.w, h: spr.h };
  }

  // ==========================================================================
  // 二、精灵仓库
  // ==========================================================================

  /**
   * 所有烘焙好的精灵都存这里。
   * 用名字（字符串）索引。游戏逻辑只写 DG.Sprites.get('da_down_a') 这种名字，
   * 不关心它是怎么烘出来的 —— 名字就是"美术"和"逻辑"之间的接口。
   */
  const store = {};

  /**
   * 定义"需要烘焙哪些精灵"。
   *
   * ★ 这种写法叫"数据驱动的初始化"★
   * 与其写 20 行重复的 bake 调用，不如列一张表，然后循环处理。
   * 好处是：以后要加新精灵，只要在这张表里加一行，不用改任何逻辑。
   *
   * 表的结构是 { 精灵名: 字符画数组 }。
   */
  function buildDefs() {
    const A = DG.ART;
    const list = {};

    // ---- 四名可选角色（每人三个方向，各两帧）----
    // ★ 精灵的命名规则是 "角色id_方向_帧"，比如 da_down_a ★
    // 定了这个规则之后，entities.js 里只要把字符串拼起来就能取到当前角色该画的帧，
    // 完全不需要为四个角色各写一套 if-else。命名规则也是一种"接口"。
    for (const id in A.CHARACTERS) {
      if (!Object.prototype.hasOwnProperty.call(A.CHARACTERS, id)) continue;
      const set = A.CHARACTERS[id];

      list[id + '_down_a'] = set.downA;
      list[id + '_down_b'] = set.downB;
      list[id + '_up_a']   = set.upA;
      list[id + '_up_b']   = set.upB;
      list[id + '_side_a'] = set.sideA; // 朝右（朝左由下面自动翻转生成）
      list[id + '_side_b'] = set.sideB;
    }

    // ---- 敌人 ----
    list.slime_a = A.SLIME.A;
    list.slime_b = A.SLIME.B;
    list.bat_a   = A.BAT.A;
    list.bat_b   = A.BAT.B;
    list.skeleton_a = A.SKELETON.A;
    list.skeleton_b = A.SKELETON.B;

    // ---- 道具 ----
    list.coin_a  = A.COIN.A;
    list.coin_b  = A.COIN.B;
    list.potion  = A.POTION;

    // ---- 界面 ----
    list.heart_full  = A.HEART.full;
    list.heart_empty = A.HEART.empty;

    return list;
  }

  /** 初始化：把定义表里的所有精灵都烘焙好，并生成对应的左右翻转版本 */
  function init() {
    const defs = buildDefs();

    for (const name in defs) {
      if (!Object.prototype.hasOwnProperty.call(defs, name)) continue;
      store[name] = bake(defs[name]);
    }

    // ---- 批量生成所有角色的"朝左"版本 ----
    // 四个角色 × 两帧 = 8 个精灵，全靠翻转得来，一个像素都不用重画。
    //
    // ★ 这里遍历的是 config.js 里的角色表，而不是手写 8 行 ★
    // 好处是：以后加第五个角色，只要在 config 和 art 里补数据，
    // 这里会自动跟着翻转生成，一行代码都不用改。
    DG.CHARACTERS.forEach(function (ch) {
      store[ch.id + '_side_l_a'] = flipH(store[ch.id + '_side_a']);
      store[ch.id + '_side_l_b'] = flipH(store[ch.id + '_side_b']);
    });

    console.log('[Sprites] 已烘焙 ' + Object.keys(store).length + ' 个精灵');
  }

  /** 按名字取精灵。找不到会返回 null 并在控制台警告（方便排查拼写错误） */
  function get(name) {
    const spr = store[name];
    if (!spr) {
      console.warn('[Sprites] 找不到精灵：' + name);
      return null;
    }
    return spr;
  }

  // ==========================================================================
  // 三、绘制接口
  // ==========================================================================

  /**
   * 把精灵画到指定位置（左上角对齐）。
   *
   * ★ 为什么坐标要 Math.round？★
   * 若 x = 10.37，浏览器会把整个精灵做亚像素抗锯齿，
   * 结果每个像素的边缘都糊掉、颜色变淡，看起来"脏"。
   * 取整后每个像素精准对齐屏幕网格，画面才锐利。
   *
   * 这是像素游戏必须做的一步，很多新手项目画面"感觉不对"
   * 就是栽在这个细节上。
   */
  function draw(ctx, spr, x, y) {
    if (!spr) return;
    ctx.drawImage(spr.canvas, Math.round(x), Math.round(y));
  }

  /**
   * 把精灵按"底部中心"对齐绘制。
   *
   * ★ 为什么用底部中心而不是几何中心？★
   * 因为俯视角游戏里，角色是"站在地面上"的。
   * 如果按几何中心对齐，玩家的"脚"和敌人的"脚"看起来会不在同一水平线上，
   * 尤其是当一个角色比另一个高的时候，视觉上会明显错位。
   *
   * 按底部对齐，所有角色就都稳稳地"踩"在同一个平面上。
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} spr 精灵
   * @param {number} cx 目标位置的横向中心
   * @param {number} by 目标位置的底边
   */
  function drawFoot(ctx, spr, cx, by) {
    if (!spr) return;
    const x = Math.round(cx - spr.w / 2);
    const y = Math.round(by - spr.h);
    ctx.drawImage(spr.canvas, x, y);
  }

  /**
   * 绘制精灵的纯色剪影（用来做"受击白闪"特效）。
   *
   * ★ 这是像素游戏最经典的打击反馈 ★
   * 敌人被击中的那 0.06 秒，整体变成纯白色，然后恢复。
   * 这个"闪白"让人眼觉得"打到了、打实了"，成本极低但效果巨大。
   *
   * 实现原理：先用 drawImage 画出原图，再用 'source-atop' 混合模式
   * 盖一层纯色 —— 这个模式的规则是"只画在已有像素上"，
   * 于是颜色就精准地填满了精灵的形状，变成剪影。
   */
  function drawFlash(ctx, spr, x, y, color) {
    if (!spr) return;
    const px = Math.round(x);
    const py = Math.round(y);

    ctx.drawImage(spr.canvas, px, py);

    ctx.save();
    ctx.globalCompositeOperation = 'source-atop'; // 只影响已有像素
    ctx.fillStyle = color;
    ctx.fillRect(px, py, spr.w, spr.h);
    ctx.restore();
  }

  // ==========================================================================
  // 四、程序化瓦片（地板 / 墙 / 楼梯）
  // ==========================================================================

  /**
   * 生成一块"石砖地板"。
   *
   * ★ 为什么地板不能是一块纯色？★
   * 因为大面积纯色在像素游戏里看起来非常"平"，像贴图的空档。
   * 加上砖缝和噪点之后，地面立刻有了材质感。
   *
   * 做法是"砖块错缝"：每行砖偏移半块，这是现实中砌墙的方式，
   * 眼睛对它有天然的熟悉感，所以看起来最"像砖地"。
   *
   * @param {number} variant 变体编号（0~3）。同一个地图用不同变体，
   *                         相邻地砖就不会一模一样，避免"复读机"感。
   */
  function makeFloorTile(variant) {
    const S = DG.TILE_SIZE; // 瓦片边长，16。所有瓦片都必须是这个尺寸，地图网格才对得上
    const c = makeCanvas(S, S);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;

    // 底色：用变体号决定深浅，制造明暗错落
    g.fillStyle = (variant % 2 === 0) ? P.floorA : P.floorB;
    g.fillRect(0, 0, S, S);

    // ---- 砖缝 ----
    // 竖向砖缝：每 8 像素一条，相邻行错开 4 像素
    g.fillStyle = P.floorC;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        // 横向砖缝：每逢 8 的倍数画一条横线
        const isHorizontalSeam = (y % 8 === 0);
        // 竖向砖缝：偏移量跟着行数走，实现"错缝"
        const offset = (Math.floor(y / 8) % 2) * 4;
        const isVerticalSeam = ((x + offset) % 8 === 0);

        if (isHorizontalSeam || isVerticalSeam) {
          g.fillRect(x, y, 1, 1);
        }
      }
    }

    // ---- 噪点 ----
    // ★ 这里用 hash2d 而不是 Math.random() ★
    // 因为这块瓦片虽然只生成一次，但我们希望"同一个变体每次启动都长得一样"，
    // 这样玩家每次玩看到的地牢是稳定的。确定性随机 = 可复现。
    g.fillStyle = P.floorC;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const n = DG.hash2d(x + variant * 31, y + variant * 17);
        if (n > 0.93) {
          g.fillRect(x, y, 1, 1);
        }
      }
    }

    return c;
  }

  /**
   * 生成一块"石墙"。
   *
   * ★ 俯视角的墙怎么画才有立体感？★
   * 关键技巧是"顶部亮、下边暗"：
   *   顶部 3 像素用亮色（假设光从上方照下来）
   *   底部 2 像素用最暗色（墙根的阴影）
   * 就这两条，平面的方块立刻就有了厚度。
   *
   * 另外墙顶画一些不规则的"碎石块"，避免一大片墙看起来像纯色背景。
   */
  function makeWallTile(variant) {
    const S = DG.TILE_SIZE;
    const c = makeCanvas(S, S);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;

    // 墙体主色
    g.fillStyle = P.wallB;
    g.fillRect(0, 0, S, S);

    // 顶面：光从上方来，所以顶部亮
    g.fillStyle = P.wallA;
    g.fillRect(0, 0, S, 3);

    // 底部阴影：墙根更暗，制造厚度感
    g.fillStyle = P.wallC;
    g.fillRect(0, S - 2, S, 2);

    // ---- 砖块纹理：错缝排列的小石砖 ----
    g.fillStyle = P.wallC;
    for (let y = 4; y < S - 2; y++) {
      for (let x = 0; x < S; x++) {
        const row = Math.floor((y - 4) / 4);
        const offset = (row % 2) * 4;
        const isSeam = (y % 4 === 0) || ((x + offset) % 8 === 0 && y > 4);
        if (isSeam) g.fillRect(x, y, 1, 1);
      }
    }

    // ---- 碎石高光：墙上随机几点亮色，破掉纯色的呆板 ----
    g.fillStyle = P.wallA;
    for (let y = 4; y < S - 3; y++) {
      for (let x = 0; x < S; x++) {
        const n = DG.hash2d(x + variant * 53, y + variant * 29);
        if (n > 0.88) g.fillRect(x, y, 1, 1);
      }
    }

    return c;
  }

  /**
   * 生成"通向下一层的楼梯"瓦片。
   *
   * ★ 视觉引导原则 ★
   * 一个游戏里最重要的东西（出口），一定要在视觉上最突出。
   * 所以这里用暗洞 + 青色台阶光效的组合：
   * 周围是暗的（洞口），台阶上带青色高光（吸引力），
   * 玩家扫一眼画面就知道"该往哪走"。
   *
   * 这就是所谓的"视觉层级"—— 重要程度决定视觉突出程度。
   */
  function makeStairsTile() {
    const S = DG.TILE_SIZE;
    const c = makeCanvas(S, S);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;

    // 洞口：接近全黑
    g.fillStyle = P.ink;
    g.fillRect(0, 0, S, S);

    // 台阶：4 级向下收窄的阶梯，越往下越暗（表示通向更深处）
    // 这种"越往下越暗"的渐变是强烈的心理暗示：下面很危险。
    for (let i = 0; i < 4; i++) {
      const y = 2 + i * 3;
      const inset = i * 2;

      // 台阶上表面：青色，亮度逐级降低
      const alpha = 1 - i * 0.22;
      g.fillStyle = P.cyan;
      g.globalAlpha = alpha;
      g.fillRect(2 + inset, y, S - 4 - inset * 2, 2);

      // 台阶前沿：更亮的一条线，增加立体感
      g.fillStyle = P.white;
      g.globalAlpha = alpha * 0.7;
      g.fillRect(2 + inset, y, S - 4 - inset * 2, 1);

      g.globalAlpha = 1;
    }

    return c;
  }

  // ==========================================================================
  // 五、瓦片仓库（瓦片也预烘焙，理由和精灵一样：每帧不能重复生成）
  // ==========================================================================

  /** 存放生成好的瓦片画布 */
  const tiles = {
    floor: [],   // 4 种地板变体
    wall: [],    // 2 种墙面变体
    stairs: null,
  };

  /** 生成所有瓦片。由 init() 调用 */
  function buildTiles() {
    tiles.floor = [
      makeFloorTile(0),
      makeFloorTile(1),
      makeFloorTile(2),
      makeFloorTile(3),
    ];
    tiles.wall = [makeWallTile(0), makeWallTile(1)];
    tiles.stairs = makeStairsTile();
  }

  /**
   * 根据地图坐标取对应的瓦片。
   *
   * ★ 为什么要按坐标选变体？★
   * 如果所有地板都用同一张图，一大片地面会呈现明显的"格子重复"感，
   * 眼睛很容易看出规律，画面就显得廉价。
   *
   * 用坐标的 hash 来选变体，就能做到"看起来随机打乱、但每次运行结果一致"，
   * 完美解决重复感。这也是真实游戏里瓦片地图的标准做法。
   *
   * @param {number} type 瓦片类型（TILE.FLOOR / TILE.WALL / TILE.STAIRS）
   * @param {number} mx   瓦片横向坐标（格数，不是像素）
   * @param {number} my   瓦片纵向坐标
   */
  function getTile(type, mx, my) {
    if (type === TILE.STAIRS) return tiles.stairs;

    if (type === TILE.WALL) {
      const v = DG.hash2d(mx * 7, my * 13) > 0.5 ? 1 : 0;
      return tiles.wall[v];
    }

    // 默认当地板处理
    const v = Math.floor(DG.hash2d(mx * 11, my * 19) * tiles.floor.length);
    return tiles.floor[DG.clamp(v, 0, tiles.floor.length - 1)];
  }

  // ==========================================================================
  // 六、导出
  // ==========================================================================

  DG.Sprites = {
    /** 初始化：烘焙所有精灵和瓦片。游戏启动时调用一次 */
    init: function () {
      init();
      buildTiles();
      console.log('[Sprites] 瓦片已生成');
    },

    get: get,
    draw: draw,
    drawFoot: drawFoot,
    drawFlash: drawFlash,
    getTile: getTile,
    flipH: flipH,
    makeCanvas: makeCanvas,
  };

})(window.DG);
