/*
  ============================================================================
  文件：src/dungeon.js —— 地牢随机生成器（每一层地图从哪来的）
  ============================================================================

  【这个文件是干嘛的？】
  每次进入新一层，它会现场"掷骰子"造出一张地图：
  随机撒几个房间 → 用走廊连起来 → 远的房间里放楼梯 → 到处撒怪和道具。

  这就是 roguelike 游戏的灵魂：**地图不是手工摆的，是算出来的**。
  所以每次玩都不一样，玩家永远有新鲜感，而开发者不用画 100 张地图。

  【你会学到什么？—— 程序化生成的经典套路】

  这套"房间 + 走廊"算法是所有地牢生成器的基础，步骤是：

    第 1 步  全图填满实心墙（先假设整个地图都是石头）
    第 2 步  ★ 随机撒房间 ★ 反复随机生成矩形，只保留不和已有房间重叠的
    第 3 步  把房间内部挖成地板（在石头上"凿"出空间）
    第 4 步  ★ 用走廊把房间连起来 ★ 否则玩家会被困在第一个房间里
    第 5 步  ★ 找最远的点放楼梯 ★ 用 BFS 算距离，保证楼梯又远又一定能走到
    第 6 步  往房间里撒怪和道具

  其中第 2、4、5 步是精华，尤其第 5 步 ——
  它是"用算法保证游戏可玩性"的典型案例。

  【你会学到什么？—— 两个重要概念】

  ★ BFS（广度优先搜索）★
  从起点开始一圈一圈往外扩散，算出到每个格子的"最少走几步"。
  想象往水里扔一块石头，涟漪一圈圈散开 —— 涟漪的圈数就是距离。
  游戏里用它做寻路、算可达性、算距离场。

  ★ Uint8Array ★
  一种"只能存 0~255 的紧凑数组"。普通 JS 数组每个元素要占几十字节，
  Uint8Array 每个元素只占 1 字节。60×40 = 2400 个格子，
  用普通数组是几十 KB，用 Uint8Array 就是 2.4KB。
  地图这种"大量小数字"的数据最适合它。

  【阅读建议】
  按 generate() 里标注的"第 1 步 ~ 第 6 步"顺序读，那就是算法的执行顺序。
  ============================================================================
*/

(function (DG) {
  'use strict';

  const TILE = DG.TILE;
  const LV = DG.LEVEL;

  // ==========================================================================
  // 一、地图数据结构
  // ==========================================================================

  /**
   * 一层地牢的全部数据。
   *
   * ★ 为什么要把一张地图的所有数据装进一个对象？★
   * 好处是"换层"变得极简单：生成一张新的 Map 对象，整个替换掉旧的就行。
   * 不需要去手动清理几十个散落的全局变量（那种写法几乎必然会漏掉一两个，
   * 然后出现"上一层的怪还留在原地"这种诡异 bug）。
   *
   * 这就是"把状态打包"的价值 —— 数据越集中，越不容易出状态残留问题。
   *
   * @constructor
   * @param {number} w 宽（格数）
   * @param {number} h 高（格数）
   * @param {number} floorNum 这是第几层（从 1 开始）
   */
  function DungeonMap(w, h, floorNum) {
    this.w = w;
    this.h = h;
    this.floorNum = floorNum;

    /**
     * 瓦片数组，长度 = w × h，一维排列。
     *
     * ★ 为什么用一维数组而不是二维数组 [[...],[...]]？★
     * 一维数组访问更快、内存更省、缓存更友好（CPU 把数据连续存放时读取最快）。
     * 二维坐标转一维下标的公式是固定的，记住它就行：
     *     下标 = y * 宽度 + x
     * 这个公式在地图相关的代码里会反复出现。
     */
    this.tiles = new Uint8Array(w * h);

    /** 所有房间的矩形信息，格式 {x, y, w, h, cx, cy}（x/y 是左上角，cx/cy 是中心） */
    this.rooms = [];

    /** 玩家出生的像素坐标 */
    this.spawn = { x: 0, y: 0 };

    /** 楼梯（下一层入口）的瓦片坐标 */
    this.stairs = { x: 0, y: 0 };

    /** 敌人出生点列表，格式 [{x, y, type}]，坐标是像素 */
    this.enemySpawns = [];

    /** 道具出生点列表，格式 [{x, y, type}]，坐标是像素 */
    this.itemSpawns = [];
  }

  /**
   * 把二维瓦片坐标转成一维数组下标。
   * 这就是上面说的那个固定公式。
   */
  DungeonMap.prototype.idx = function (x, y) {
    return y * this.w + x;
  };

  /** 判断坐标是否在地图范围内（防止数组越界访问） */
  DungeonMap.prototype.inBounds = function (x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  };

  /** 读取某个格子的瓦片类型 */
  DungeonMap.prototype.get = function (x, y) {
    if (!this.inBounds(x, y)) return TILE.VOID; // 越界当成虚空，配合碰撞检测很自然
    return this.tiles[this.idx(x, y)];
  };

  /** 写入某个格子的瓦片类型 */
  DungeonMap.prototype.set = function (x, y, type) {
    if (!this.inBounds(x, y)) return;
    this.tiles[this.idx(x, y)] = type;
  };

  /** 这个格子能走吗？（地板和楼梯都是能走的） */
  DungeonMap.prototype.isWalkable = function (x, y) {
    const t = this.get(x, y);
    return t === TILE.FLOOR || t === TILE.STAIRS;
  };

  /**
   * 把"像素坐标"转成"瓦片坐标"。
   *
   * ★ 这个转换在游戏里到处都是 ★
   * 游戏世界用像素算（因为移动要平滑），地图用格子算（因为存储要紧凑）。
   * 两者之间就靠除以格子尺寸来转换。向下取整是因为
   * 像素 0~15 都属于第 0 格，16~31 都属于第 1 格。
   */
  DG.pxToTile = function (px) {
    return Math.floor(px / DG.TILE_SIZE);
  };

  // ==========================================================================
  // 二、生成主流程
  // ==========================================================================

  /**
   * 生成一层新地牢。
   *
   * @param {number} floorNum 第几层（数字越大怪越多越强）
   * @returns {DungeonMap}
   */
  function generate(floorNum) {
    const map = new DungeonMap(LV.MAP_W, LV.MAP_H, floorNum);

    // ----------------------------------------------------------------------
    // 第 1 步：全图填满墙（先假设整个世界都是石头）
    // ----------------------------------------------------------------------
    map.tiles.fill(TILE.WALL);

    // ----------------------------------------------------------------------
    // 第 2 步：随机撒房间
    // ----------------------------------------------------------------------
    map.rooms = placeRooms(map);

    // ----------------------------------------------------------------------
    // 第 3 步：把房间内部挖成地板
    // ----------------------------------------------------------------------
    map.rooms.forEach(function (room) {
      carveRoom(map, room);
    });

    // 兜底检查：极罕见的情况下（随机数运气特别差）可能只撒出 1 个房间。
    // 那就强行再生成一次。这种"生成失败就重试"是程序化生成的常用兜底手法。
    if (map.rooms.length < 2) {
      console.warn('[Dungeon] 房间太少，重新生成');
      return generate(floorNum);
    }

    // ----------------------------------------------------------------------
    // 第 4 步：用走廊把房间连起来
    // ----------------------------------------------------------------------
    connectRooms(map);

    // ----------------------------------------------------------------------
    // 第 5 步：找出"离出生点最远的可达格子"，在那里放楼梯
    // ----------------------------------------------------------------------
    pickSpawnAndStairs(map);

    // ----------------------------------------------------------------------
    // 第 6 步：撒怪和道具
    // ----------------------------------------------------------------------
    populate(map, floorNum);

    return map;
  }

  // ==========================================================================
  // 三、第 2 步：撒房间
  // ==========================================================================

  /**
   * 随机生成若干互不重叠的矩形房间。
   *
   * ★ 核心思路："随机尝试 + 碰撞检查"★
   *
   * 我们不是精确计算该把房间放哪，而是随便乱放，
   * 然后检查"会不会和别人重叠"，重叠就扔掉重新放。
   * 一直试到凑够数量，或者试的次数太多就放弃。
   *
   * 这种"拒绝采样"（rejection sampling）的思路简单粗暴但极其好用，
   * 几乎所有的地牢生成器都用它。
   *
   * @param {DungeonMap} map
   * @returns {Array} 房间列表
   */
  function placeRooms(map) {
    const rooms = [];
    const wantCount = DG.randInt(LV.ROOMS[0], LV.ROOMS[1] + 1); // 想要几个房间
    const maxTry = 200;  // 最多尝试多少次（防止运气差时死循环）
    let tries = 0;

    while (rooms.length < wantCount && tries < maxTry) {
      tries++;

      // 随机房间尺寸和位置
      const rw = DG.randInt(LV.ROOM_SIZE[0], LV.ROOM_SIZE[1] + 1);
      const rh = DG.randInt(LV.ROOM_SIZE[0], LV.ROOM_SIZE[1] + 1);

      // 位置要留出墙壁的厚度，所以可用范围是 [1, 地图宽 - 房间宽 - 1]
      // 若不留边，房间会紧贴地图边缘，玩家走到边上会觉得"世界被切断了"
      const rx = DG.randInt(1, map.w - rw - 1);
      const ry = DG.randInt(1, map.h - rh - 1);

      const candidate = {
        x: rx,
        y: ry,
        w: rw,
        h: rh,
        // 中心点，后面连接走廊和放怪都用它，先算好省得反复算
        cx: Math.floor(rx + rw / 2),
        cy: Math.floor(ry + rh / 2),
      };

      // ---- 重叠检查 ----
      // 注意这里用的是**加了间隔**的矩形来判断重叠，而不是房间本身。
      // 这样两个房间之间至少会隔 ROOM_GAP 格墙，
      // 否则房间挨太近会"融"成一大片空地，失去地牢的迷宫感。
      const padded = {
        x: candidate.x - LV.ROOM_GAP,
        y: candidate.y - LV.ROOM_GAP,
        w: candidate.w + LV.ROOM_GAP * 2,
        h: candidate.h + LV.ROOM_GAP * 2,
      };

      const overlaps = rooms.some(function (other) {
        return rectsOverlap(padded, other);
      });

      if (!overlaps) rooms.push(candidate);
    }

    return rooms;
  }

  /**
   * 判断两个矩形是否有重叠部分。
   *
   * ★ 这是最经典的 AABB 碰撞检测（Axis-Aligned Bounding Box，轴对齐包围盒）★
   *
   * 判断"重叠"看起来复杂，但反过来判断"不重叠"极其简单，
   * 只有四种情况：A 在 B 左边 / 右边 / 上边 / 下边。
   * 只要这四种都不成立，那就是重叠了。
   *
   * 这个技巧叫"用反命题简化判断"，是写碰撞检测的标准思路。
   *
   * @param {{x,y,w,h}} a
   * @param {{x,y,w,h}} b
   */
  function rectsOverlap(a, b) {
    // 四个"分离"条件，任一成立就说明不重叠
    const aIsLeftOfB   = a.x + a.w <= b.x;
    const aIsRightOfB  = a.x >= b.x + b.w;
    const aIsAboveB    = a.y + a.h <= b.y;
    const aIsBelowB    = a.y >= b.y + b.h;

    return !(aIsLeftOfB || aIsRightOfB || aIsAboveB || aIsBelowB);
  }

  /** 把房间内部挖空成地板 */
  function carveRoom(map, room) {
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        map.set(x, y, TILE.FLOOR);
      }
    }
  }

  // ==========================================================================
  // 四、第 4 步：连接房间
  // ==========================================================================

  /**
   * 用走廊把所有房间连成一张连通图。
   *
   * ★ 这里用的是"最近邻生长"策略 ★
   *
   * 如果按房间顺序两两相连（1-2, 2-3, 3-4...），走廊会绕来绕去很难看。
   * 更好的办法是：
   *   1. 从第一个房间开始，把它标记为"已连通"
   *   2. 反复在所有"已连通房间"和"未连通房间"之间，找出距离最近的一对
   *   3. 把它们连起来，新房间也变成已连通
   *   4. 重复直到所有房间都连通
   *
   * 这样长出来的走廊短而自然，而且**保证连通**（不会出现有房间进不去）。
   * 这个算法本质上是"最小生成树"的简化版。
   */
  function connectRooms(map) {
    const rooms = map.rooms;
    if (rooms.length < 2) return;

    // connected 存已连通的房间下标，剩下的都是待连通
    const connected = [0];
    const pending = [];
    for (let i = 1; i < rooms.length; i++) pending.push(i);

    while (pending.length > 0) {
      // ---- 找出"已连通"和"待连通"之间距离最近的一对 ----
      let bestA = -1;
      let bestB = -1;
      let bestDist = Infinity;

      for (let i = 0; i < connected.length; i++) {
        for (let j = 0; j < pending.length; j++) {
          const a = rooms[connected[i]];
          const b = rooms[pending[j]];
          // 用曼哈顿距离（横向差 + 纵向差）就够了。
          // 为什么不用直线距离 √(dx²+dy²)？因为走廊本来就是横平竖直走的，
          // 曼哈顿距离更贴近"实际要走多远"，而且不用开平方，更快。
          const dist = Math.abs(a.cx - b.cx) + Math.abs(a.cy - b.cy);
          if (dist < bestDist) {
            bestDist = dist;
            bestA = connected[i];
            bestB = pending[j];
          }
        }
      }

      if (bestB < 0) break; // 保险：理论上不会发生

      // ---- 连接这一对 ----
      carveCorridor(map, rooms[bestA], rooms[bestB]);

      // 把刚连上的房间从"待连通"移到"已连通"
      connected.push(bestB);
      pending.splice(pending.indexOf(bestB), 1);
    }
  }

  /**
   * 挖一条 L 形走廊，把房间 A 和房间 B 连起来。
   *
   * ★ 为什么是 L 形？★
   * 因为走廊要横平竖直（地牢的墙都是方的），而从 A 到 B 必然要
   * 横着走一段、竖着走一段 —— 这两段拼起来正好是个 L。
   *
   * 随机决定"先横后竖"还是"先竖后横"，可以让每层地牢的布局更有变化。
   */
  function carveCorridor(map, a, b) {
    if (Math.random() < 0.5) {
      carveH(map, a.cx, b.cx, a.cy);              // 先横着走到 B 的横向位置
      carveV(map, a.cy, b.cy, b.cx);              // 再竖着走到 B
    } else {
      carveV(map, a.cy, b.cy, a.cx);              // 先竖后横
      carveH(map, a.cx, b.cx, b.cy);
    }
  }

  /**
   * 在 y 这一行上，从 x1 挖到 x2（挖 H 形 = 横着的走廊）。
   * 支持 x1 > x2（从右往左挖），所以先排序确保循环方向正确。
   */
  function carveH(map, x1, x2, y) {
    const from = Math.min(x1, x2);
    const to = Math.max(x1, x2);

    for (let x = from; x <= to; x++) {
      // 走廊宽度是 CORRIDOR_W 格。挖宽度时是"往上挖"还是"往下挖"？
      // 这里选择居中：奇数宽就对称挖，偶数宽就稍微偏一点。
      // 2 格宽的走廊走起来最舒服 —— 1 格容易被怪堵死，3 格又太浪费空间。
      for (let k = 0; k < LV.CORRIDOR_W; k++) {
        const yy = y + k - Math.floor(LV.CORRIDOR_W / 2) + 1;
        map.set(x, yy, TILE.FLOOR);
      }
    }
  }

  /** 在 x 这一列上，从 y1 挖到 y2（挖 V 形 = 竖着的走廊） */
  function carveV(map, y1, y2, x) {
    const from = Math.min(y1, y2);
    const to = Math.max(y1, y2);

    for (let y = from; y <= to; y++) {
      for (let k = 0; k < LV.CORRIDOR_W; k++) {
        const xx = x + k - Math.floor(LV.CORRIDOR_W / 2) + 1;
        map.set(xx, y, TILE.FLOOR);
      }
    }
  }

  // ==========================================================================
  // 五、第 5 步：用 BFS 找最远点，在那里放楼梯
  // ==========================================================================

  /**
   * 决定玩家出生点和楼梯位置。
   *
   * ★ 这是整个生成器里最重要的一步 ★
   *
   * 为什么不随便挑个房间放楼梯？因为有两个坑：
   *
   *   坑 1：楼梯可能和出生点在同一间房 —— 玩家一进去就上楼了，毫无游戏体验。
   *   坑 2：楼梯可能在玩家**走不到**的地方 —— 如果生成算法有 bug，
   *          或者走廊挖得不通，玩家就会永远卡在这一层。这是致命的。
   *
   * 解法：用 BFS 从出生点做一次洪水填充，算出**所有可达格子**的距离。
   * 然后在可达的格子里挑距离最大的那个放楼梯。
   *
   * 这样一次同时解决两个问题：
   *   ① 楼梯一定离出生点最远（逼玩家探索整张地图）
   *   ② 楼梯一定可达（BFS 只标记走得到的格子）
   *
   * 这就是"用算法保证游戏可玩性"—— 不靠运气，靠数学。
   */
  function pickSpawnAndStairs(map) {
    // ---- 出生点：第一个房间的正中心 ----
    const first = map.rooms[0];
    map.spawn.x = (first.cx + 0.5) * DG.TILE_SIZE;
    map.spawn.y = (first.cy + 0.5) * DG.TILE_SIZE;

    // ---- BFS 洪水填充，算出距离场 ----
    // dist 数组存"从出生点到这一格的最少步数"，-1 表示走不到
    const dist = new Int16Array(map.w * map.h).fill(-1);

    // ★ 队列：用数组 + 一个读指针实现 ★
    // 教科书式的队列会教你用 shift() 出队，但 shift() 每次都要
    // 把数组里所有元素往前挪一格，在几千个元素时慢得惊人。
    // 用"读指针 + 只往尾部 push"的方式，出队就是指针加一，是 O(1) 的。
    // 这个小技巧在处理大量数据时非常重要。
    const queue = [];
    let head = 0;

    const startIdx = map.idx(first.cx, first.cy);
    dist[startIdx] = 0;
    queue.push({ x: first.cx, y: first.cy });

    // 四个方向的偏移量。用数组存起来，循环处理，比写四段重复代码清爽
    const DIRS = [
      { dx: 0, dy: -1 }, // 上
      { dx: 0, dy: 1 },  // 下
      { dx: -1, dy: 0 }, // 左
      { dx: 1, dy: 0 },  // 右
    ];

    let farthest = { x: first.cx, y: first.cy, d: 0 };

    while (head < queue.length) {
      const cur = queue[head++]; // 出队：读指针前移
      const curDist = dist[map.idx(cur.x, cur.y)];

      // 记录目前为止最远的格子
      if (curDist > farthest.d) {
        farthest = { x: cur.x, y: cur.y, d: curDist };
      }

      // 向四个方向扩散
      for (let i = 0; i < DIRS.length; i++) {
        const nx = cur.x + DIRS[i].dx;
        const ny = cur.y + DIRS[i].dy;

        // 跳过：越界 / 不是可走的地板 / 已经访问过
        if (!map.isWalkable(nx, ny)) continue;
        const nIdx = map.idx(nx, ny);
        if (dist[nIdx] !== -1) continue; // 已经访问过了，这是防止绕圈的关键

        dist[nIdx] = curDist + 1; // 距离 = 来源格距离 + 1
        queue.push({ x: nx, y: ny });
      }
    }

    // ---- 在最远处放楼梯 ----
    map.stairs.x = farthest.x;
    map.stairs.y = farthest.y;
    map.set(farthest.x, farthest.y, TILE.STAIRS);

    // 调试信息：开发时能一眼看出地图生成了多少格、最远距离是多少
    console.log(
      '[Dungeon] 第 ' + map.floorNum + ' 层：' +
      map.rooms.length + ' 个房间，最远距离 ' + farthest.d + ' 步'
    );
  }

  // ==========================================================================
  // 六、第 6 步：撒怪和道具
  // ==========================================================================

  /**
   * 往地图上撒敌人和道具。
   *
   * ★ 设计原则：出生房间必须是安全的 ★
   * 想象一下：玩家刚进新一层，还没看清画面就有三只怪扑上来 ——
   * 这是极其糟糕的体验。所以第一间房（出生房）绝对不放敌怪。
   *
   * 这体现了"难度要设计，不能随机"的原则：
   * 随机的是"怪在哪个房间、有几只"，但"出生点安全"是硬规则。
   */
  function populate(map, floorNum) {
    // ---- 计算这层要放多少怪 ----
    // 层数越深怪越多，但有上限（否则后期一屏几百只怪，性能和体验都崩）
    let enemyCount = LV.ENEMIES_BASE + (floorNum - 1) * LV.ENEMIES_PER_FLOOR;
    enemyCount = Math.min(enemyCount, LV.ENEMIES_MAX);

    // ---- 可选敌人种类池，随层数解锁 ----
    // ★ 这是"渐进式难度"的经典做法 ★
    // 第一层只有最弱的史莱姆，让玩家先学会基本操作；
    // 第二层引入蝙蝠（逼玩家学走位）；第四层才上骷髅（逼玩家做取舍）。
    // 每引入一种新敌人，就相当于给玩家上了一课新内容。
    const pool = ['slime'];
    if (floorNum >= 2) pool.push('bat');
    if (floorNum >= 4) pool.push('skeleton');

    // 敌人和道具都跳过第一个房间（出生房）
    const usableRooms = map.rooms.slice(1);

    // ---- 撒敌人 ----
    for (let i = 0; i < enemyCount; i++) {
      const pos = randomFloorInRooms(map, usableRooms);
      if (!pos) continue; // 找不到合适位置就跳过（宁可少一只怪，也不要报错）

      map.enemySpawns.push({
        x: (pos.x + 0.5) * DG.TILE_SIZE, // +0.5 格 = 落在格子正中心，视觉最自然
        y: (pos.y + 0.5) * DG.TILE_SIZE,
        type: DG.pick(pool),
      });
    }

    // ---- 撒金币 ----
    for (let i = 0; i < LV.COINS; i++) {
      const pos = randomFloorInRooms(map, usableRooms);
      if (!pos) continue;
      map.itemSpawns.push({
        x: (pos.x + 0.5) * DG.TILE_SIZE,
        y: (pos.y + 0.5) * DG.TILE_SIZE,
        type: 'coin',
      });
    }

    // ---- 撒血瓶 ----
    for (let i = 0; i < LV.POTIONS; i++) {
      const pos = randomFloorInRooms(map, usableRooms);
      if (!pos) continue;
      map.itemSpawns.push({
        x: (pos.x + 0.5) * DG.TILE_SIZE,
        y: (pos.y + 0.5) * DG.TILE_SIZE,
        type: 'potion',
      });
    }
  }

  /**
   * 在一组房间里随机找一个"干净的"地板格子。
   *
   * "干净"的意思是：是普通地板（不是楼梯），
   * 而且**不要挨着墙** —— 如果怪生成在紧贴墙的位置，
   * 它会被墙卡住动不了，玩家看到的就是一只在原地抽搐的怪，很出戏。
   *
   * 所以我们会检查周围 8 个格子都是地板，才认为这个位置合格。
   *
   * @returns {{x:number, y:number}|null} 找不到合格位置就返回 null
   */
  function randomFloorInRooms(map, rooms) {
    if (rooms.length === 0) return null;

    // 尝试 30 次，找不到就放弃（比死循环好）
    for (let attempt = 0; attempt < 30; attempt++) {
      const room = DG.pick(rooms);

      // 在房间内部随机取一点，但避开最外圈 —— 最外圈紧贴墙
      const x = DG.randInt(room.x + 1, room.x + room.w - 1);
      const y = DG.randInt(room.y + 1, room.y + room.h - 1);

      if (map.get(x, y) !== TILE.FLOOR) continue; // 不是地板（可能被楼梯占了）

      // 检查周围八格是否都是地板（避免贴墙）
      let clean = true;
      for (let dy = -1; dy <= 1 && clean; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (map.get(x + dx, y + dy) !== TILE.FLOOR) {
            clean = false;
            break;
          }
        }
      }

      if (clean) return { x: x, y: y };
    }

    return null;
  }

  // ==========================================================================
  // 七、导出
  // ==========================================================================

  DG.Dungeon = {
    generate: generate,
    DungeonMap: DungeonMap,
    rectsOverlap: rectsOverlap,
  };

})(window.DG);
