/*
  ============================================================================
  文件：src/entities.js —— 实体系统（游戏里所有"会动的东西"）
  ============================================================================

  【这个文件是干嘛的？】
  玩家、敌人、道具、粒子特效 —— 所有"有位置、会更新、要绘制"的东西都在这里。
  每个实体就是一个"类"（class 的等价写法），有自己的一套数据和行为。

  【你会学到什么？—— 三个极其重要的游戏开发概念】

  ★★ 概念 1：碰撞盒 ≠ 精灵尺寸 ★★

  这是新手和老手最大的分水岭。看这张图：

       精灵 12×14              实际碰撞盒 8×6
      ┌────────────┐          ┌────────────┐
      │   头发      │          │            │
      │   脸        │          │            │
      │   身体      │          │  ▓▓▓▓▓▓▓▓  │  ← 只有脚下这一小块参与碰撞
      │   腿        │          │  ▓▓▓▓▓▓▓▓  │
      └────────────┘          └────────────┘

  为什么？因为俯视角是"斜着往下看"的视角，角色其实是"站"在地面上的。
  如果整个 12×14 都参与碰撞，那么角色的头会被墙挡住 ——
  但实际上头应该能"盖"在墙的上方，因为它比墙高。

  所以正确做法是：用一个只有脚那么大的小盒子做碰撞（8×6），
  这个盒子叫"影子碰撞盒"。这样角色就能自然地走到墙边，
  头稍微压到墙上一部分，看起来才有立体感。

  **几乎所有俯视角游戏都在用这个技巧。**

  ★★ 概念 2：击退（Knockback）★★

  打中敌人时，除了扣血，还要把它往反方向弹开一段距离。
  这个"弹开"是打击感的核心来源 —— 玩家能**感觉到**自己的攻击有力量。

  实现上它是一个"会自己衰减的速度"：被打中时设置一个速度，
  然后每帧乘以一个小于 1 的数（比如 0.88），它就会越来越慢，
  几帧后归零，效果看起来就像被"弹"了一下。

  这个技巧有个形象的叫法："指数衰减"或"阻尼"。

  ★★ 概念 3：分离力（Separation）★★

  如果一群敌人同时追你，它们会完全重叠在一起，变成一坨分不清的色块。
  解决办法是给每个敌人加一个"互相推开"的力 ——
  当两个敌人靠得太近时，它们会朝相反方向微微挪开。
  这样敌群就会自然散开，看起来像一群生物而不是一个色块。

  【阅读建议】
  先读 Entity 基类，再读 Player（最复杂的），然后是 Enemy，最后扫一眼 Item 和 Particle。
  ============================================================================
*/

(function (DG) {
  'use strict';

  const P = DG.PALETTE;

  // ==========================================================================
  // 一、碰撞检测工具（所有实体共用）
  // ==========================================================================

  /**
   * 判断某个像素点是不是在"实心"（墙或虚空）里。
   *
   * 注意要先转成瓦片坐标再查地图 —— 地图按格子存，所以必须转换。
   */
  function isSolidAt(map, px, py) {
    const tx = DG.pxToTile(px);
    const ty = DG.pxToTile(py);
    return DG.isSolid(map.get(tx, ty));
  }

  /**
   * 判断一个矩形碰撞盒是否撞到了墙。
   *
   * ★ 为什么只检查四个角就够了？★
   * 因为碰撞盒永远比一个格子（16×16）小。
   * 一个比格子小的矩形如果要和格子网格重叠，
   * 那么它的四个角里必然至少有一个落在实心格里 ——
   * 不可能出现"四个角都在空地、但中间压着墙"的情况。
   *
   * 这个推理让碰撞检测从"检查覆盖的所有格子"（可能几十次）
   * 简化为"检查 4 个点"（固定 4 次）。这是很典型的性能优化思路：
   * **利用几何性质把 O(n) 降到 O(1)**。
   *
   * @param {number} cx 盒子中心 x
   * @param {number} cy 盒子中心 y
   * @param {number} hw 盒子半宽（half width）
   * @param {number} hh 盒子半高（half height）
   */
  function boxHitsWall(map, cx, cy, hw, hh) {
    const left = cx - hw;
    const right = cx + hw;
    const top = cy - hh;
    const bottom = cy + hh;

    return (
      isSolidAt(map, left, top) ||
      isSolidAt(map, right, top) ||
      isSolidAt(map, left, bottom) ||
      isSolidAt(map, right, bottom)
    );
  }

  /**
   * 分轴移动：先试着移动 X，再试着移动 Y。
   *
   * ★ 为什么要"分轴"而不是"一起移动"？★
   * 假设玩家贴着墙往右上走。如果 x 和 y 一起加，整个盒子会同时往两个方向挪，
   * 一旦撞墙就被完全卡住 —— 玩家会觉得"贴着墙就走不动了"，非常难受。
   *
   * 分轴移动则允许"被挡住一个轴、另一个轴照样走"：
   *   X 方向撞墙 → x 不动，但 y 依然生效 → 玩家沿着墙滑行
   *
   * 这个"贴墙滑行"是手感好坏的关键之一。玩家不会意识到它的存在，
   * 但一旦没有它，操作会立刻变得笨重难受。
   *
   * @returns {{x:number, y:number}} 实际移动成功的距离
   */
  function moveWithCollision(map, ent, dx, dy) {
    let movedX = 0;
    let movedY = 0;

    // ---- 先处理 X 轴 ----
    if (dx !== 0) {
      const nx = ent.x + dx;
      if (!boxHitsWall(map, nx, ent.y, ent.hw, ent.hh)) {
        ent.x = nx;
        movedX = dx;
      } else {
        // 撞墙了。这里可以加一个"贴紧墙面"的处理，
        // 但简单起见直接取消这次移动 —— 因为下一帧玩家按键方向通常就变了，
        // 视觉上感觉不出来。这就是所谓的"够用就好"。
        movedX = 0;
      }
    }

    // ---- 再处理 Y 轴 ----
    // 注意用的是**可能已经更新过的 ent.x**，这样斜向撞墙时能正确滑行
    if (dy !== 0) {
      const ny = ent.y + dy;
      if (!boxHitsWall(map, ent.x, ny, ent.hw, ent.hh)) {
        ent.y = ny;
        movedY = dy;
      } else {
        movedY = 0;
      }
    }

    return { x: movedX, y: movedY };
  }

  /** 两个矩形是否相交（用于攻击判定和拾取判定） */
  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // ==========================================================================
  // 二、实体基类
  // ==========================================================================

  /**
   * 所有实体的共同父亲。
   *
   * ★ 为什么要有个"基类"？★
   * 玩家、敌人、道具都有一些**一模一样**的属性：位置、速度、碰撞盒、
   * 是不是死了、怎么被绘制。这些公共部分放在基类里，子类就不用重复写。
   *
   * 更妙的是 game.js 里可以统一处理："遍历所有实体，调用它们的 update()"，
   * 不用分别写"更新玩家、更新敌人、更新道具"三套逻辑 ——
   * 以后加新实体类型（比如陷阱、宝箱），游戏主循环一行都不用改。
   *
   * 这就是"多态"的价值：主循环只关心"你是个实体"，不关心"你具体是什么"。
   *
   * ★ 关于坐标 ★
   * x, y 指的是**碰撞盒的中心**，不是精灵的左上角！
   * 绘制的时候要再算一遍偏移（见下面的 drawY 计算）。
   * 这样设计是因为碰撞和移动都围绕中心算，代码最简洁。
   */
  function Entity(x, y) {
    this.x = x;            // 碰撞盒中心 x
    this.y = y;            // 碰撞盒中心 y
    this.vx = 0;           // X 方向速度（像素/秒）
    this.vy = 0;           // Y 方向速度
    this.kx = 0;           // 击退速度 X（独立于 vx，因为它的衰减方式不同）
    this.ky = 0;           // 击退速度 Y
    this.hw = 4;           // 碰撞盒半宽
    this.hh = 3;           // 碰撞盒半高
    this.dead = false;     // 标记为 true 后会被 game.js 清理掉
    this.animT = 0;        // 动画计时器（秒）
    this.hitFlash = 0;     // 受击白闪剩余时间（秒）
    this.sprite = null;    // 当前该画哪个精灵（由子类每帧决定）
  }

  /**
   * 更新击退速度的衰减。
   *
   * ★ 用指数衰减而不是线性递减 ★
   * 线性递减（每帧减固定值）的问题是：不管初始速度多大，
   * 弹开的"手感"都一样，而且停下时会显得很突然。
   * 指数衰减则是"速度越快衰减越多"，弹开效果更自然 ——
   * 一开始飞快，迅速减速，最后轻轻滑停，就像现实中物体被摩擦减速。
   *
   * 数学上就是每帧乘一个 0.88 这样的系数，
   * 连续几帧下来就是 0.88ⁿ，指数级趋近 0。
   *
   * @param {number} dt 时间步长（秒）
   */
  Entity.prototype.applyKnockbackDecay = function (dt) {
    // Math.pow(0.0001, dt) 是一个"与帧率无关"的衰减系数。
    //
    // 如果直接写 this.kx *= 0.88，那帧率越高衰减越快（因为乘得次数多），
    // 就出现了"高刷屏上敌人被弹得更近"的帧率相关 bug。
    //
    // 正确做法是把"每秒衰减到原来的多少"算出来，再按 dt 取幂。
    // 这里表示"每秒衰减到万分之一"，任何帧率下结果都一致。
    const decay = Math.pow(0.0001, dt);
    this.kx *= decay;
    this.ky *= decay;

    // 速度小到一定程度就直接归零，避免出现 0.0001 这种
    // "数值上还在动、但视觉上早就停了"的僵尸状态
    if (Math.abs(this.kx) < 1) this.kx = 0;
    if (Math.abs(this.ky) < 1) this.ky = 0;
  };

  /** 通用的位置更新（速度 + 击退量一起算） */
  Entity.prototype.integrate = function (map, dt) {
    const dx = (this.vx + this.kx) * dt;
    const dy = (this.vy + this.ky) * dt;
    moveWithCollision(map, this, dx, dy);
  };

  /** 让动画计时器走一格 */
  Entity.prototype.tickAnim = function (dt) {
    this.animT += dt;
    if (this.hitFlash > 0) this.hitFlash -= dt;
  };

  /**
   * 计算精灵该画在哪。
   *
   * ★ 这是"碰撞盒中心 → 精灵底部中心"的转换 ★
   *
   * 碰撞盒中心在脚部附近，而精灵是从头到脚的完整图像。
   * 所以精灵的底边应该对齐到碰撞盒的底边：
   *     精灵底边 y = 碰撞盒中心 y + 半个碰撞盒高
   * 然后 drawFoot 会自己把精灵往上推它的高度。
   */
  Entity.prototype.getSpriteBottomY = function () {
    return this.y + this.hh;
  };

  // ==========================================================================
  // 三、玩家
  // ==========================================================================

  /**
   * 玩家实体。
   *
   * @param {number} x 出生点像素坐标
   * @param {number} y
   * @param {string} charId 选了哪个角色（对应 config.js 里 DG.CHARACTERS 的 id）
   */
  function Player(x, y, charId) {
    Entity.call(this, x, y); // ★ 关键：调用父类构造函数，把基类的属性都初始化好

    // ------------------------------------------------------------------------
    // ★ 角色配置 ★
    // ------------------------------------------------------------------------
    // 四名角色共用**完全一样**的行为代码，区别只在于这张数据表里的数字。
    // 想调数值请去 config.js，千万不要在这里写死任何数字 ——
    // 一旦写死，这个角色就和另外三个"不是一个物种"了，以后没法统一调平衡。
    this.charId = charId || DG.CHARACTERS[0].id;
    this.stats = DG.getCharacter(this.charId);

    // ---- 碰撞盒：8×6，只有脚那么大（见文件头的"概念 1"）----
    // ★ 四个角色共用同一个碰撞盒，体型大的也不放大 ★
    // 因为放大之后，"大"这个角色在狭窄走廊里会寸步难行，
    // 而玩家会觉得"我明明看着能过去"—— 判定和视觉一旦不符，手感立刻崩。
    // 角色差异应该体现在战斗数值上，而不是让人卡在墙里。
    this.hw = 4;
    this.hh = 3;

    // ---- 生命（直接来自角色配置）----
    this.maxHp = this.stats.maxHp;
    this.hp = this.maxHp;

    // ---- 朝向：'down' / 'up' / 'left' / 'right' ----
    // 这个值决定三件事：画哪个精灵、攻击往哪个方向打、击退往哪个方向推。
    // ★ 注意默认朝下 ★ —— 因为刚进场时玩家能看到自己的脸，
    // 这比看到后脑勺友好得多。这种小细节叫"第一印象设计"。
    this.facing = 'down';

    // ---- 攻击状态 ----
    this.attacking = false;    // 是否正在挥击
    this.attackTimer = 0;      // 这次挥击还剩多少秒
    this.attackCooldown = 0;   // 距离下次能攻击还有多少秒
    this.swingSeq = 0;         // 第几次挥击（用来给攻击特效做细微变化）

    /**
     * ★ 这一击已经打到过哪些敌人 ★
     * 没有它就会出现"一刀砍十下"的 bug：
     * 因为挥击持续 0.18 秒 ≈ 11 帧，如果每帧都判定，
     * 同一个敌人会被这一刀连续伤害 11 次，直接秒杀。
     * 用 Set 记录已经命中过的敌人，保证"一击对同一个敌人只生效一次"。
     */
    this.hitThisSwing = new Set();

    /**
     * ★ 远程角色的"开火申请" ★
     *
     * 法师在 startAttack 里只会把这个标记设为 true，
     * 真正把火球塞进世界的工作交给 game.js 去做。
     *
     * 为什么不在这儿直接生成？因为火球要进"游戏世界"的实体列表，
     * 而 Player 不应该知道 game.projectiles 这种东西的存在 ——
     * 它只管喊一声"我要开火了"，不关心世界怎么处理。这叫**职责分离**。
     */
    this.pendingShot = false;

    // ---- 无敌帧 ----
    this.invuln = 0;

    // ---- 走路动画 ----
    this.walkTimer = 0;
    this.moving = false;
    this.sprite = this.charId + '_down_a';
  }
  // 建立原型链：让 Player 继承 Entity 的所有方法。
  // Object.create 创建一个"以 Entity.prototype 为父亲"的新对象，
  // 这样 Player 的实例找不到某个方法时，会自动往上去 Entity 上找。
  Player.prototype = Object.create(Entity.prototype);
  Player.prototype.constructor = Player; // 修正 constructor 指向（好习惯）

  /**
   * 每帧更新玩家。
   *
   * @param {number} dt 时间步长
   * @param {object} map 地图
   * @param {object} input DG.Input（用它读按键）
   */
  Player.prototype.update = function (dt, map, input) {
    // ★ 从"全局默认值"改成了"这名角色的数值表" ★
    // 下面所有速度、时长、判定尺寸都从这里取，
    // 于是同一份代码就能跑出四种完全不同的手感。
    const S = this.stats;

    this.tickAnim(dt);

    // ---- 计时器递减 ----
    if (this.attackCooldown > 0) this.attackCooldown -= dt;
    if (this.invuln > 0) this.invuln -= dt;
    if (this.attackTimer > 0) {
      this.attackTimer -= dt;
      if (this.attackTimer <= 0) {
        this.attacking = false; // 挥剑结束
      }
    }

    // ---- 读输入 ----
    const mv = input.getMoveVector(); // 已归一化的方向向量，长度 0 或 1
    this.moving = (mv.x !== 0 || mv.y !== 0);

    // ---- 更新朝向 ----
    // ★ 为什么横向优先？★
    // 俯视角游戏里，如果同时按了右和下，朝向应该给"右"。
    // 因为横着的角色看起来比朝下的更有"移动感"，
    // 而且这样斜向走位时角色会保持侧身，视觉上更自然。
    // 这是一个纯粹的经验性选择，你可以改成纵向优先试试哪个更顺眼。
    if (mv.x !== 0) {
      this.facing = mv.x > 0 ? 'right' : 'left';
    } else if (mv.y !== 0) {
      this.facing = mv.y > 0 ? 'down' : 'up';
    }

    // ---- 计算速度 ----
    // ★ 挥剑时会减速到 45% ★
    // 这叫"攻击硬直"：攻击时不能全速移动，否则玩家可以边打边跑，
    // 战斗就变成了无脑冲。减速之后玩家必须想清楚"这一刀砍下去我就要停一下"，
    // 攻击就有了代价，战斗才有取舍。
    const speed = this.attacking ? S.speed * 0.45 : S.speed;
    this.vx = mv.x * speed;
    this.vy = mv.y * speed;

    // ---- 挥剑前冲 ----
    // 攻击刚开始的那一瞬间给一个向前的冲量，让攻击显得有力量。
    // 因为 kx/ky 是"会自己衰减的速度"，所以这个冲量会自然消散，
    // 效果就像"冲出去一步然后刹住"。
    if (this.attacking && this.attackTimer > S.atkDuration * 0.6) {
      const dir = this.getFacingVector();
      this.kx += dir.x * S.atkLunge * dt * 8;
      this.ky += dir.y * S.atkLunge * dt * 8;
    }

    // ---- 攻击输入 ----
    if (input.isPressed('attack') && this.attackCooldown <= 0) {
      this.startAttack();
    }

    // ---- 位置更新 ----
    this.applyKnockbackDecay(dt);
    this.integrate(map, dt);

    // ---- 选动画帧 ----
    this.updateSprite(dt);

    // ---- 攻击结束后清空命中记录 ----
    if (!this.attacking && this.hitThisSwing) {
      this.hitThisSwing.clear();
    }
  };

  /**
   * 开始一次挥剑。
   * 不直接造成伤害 —— 伤害判定在 game.js 里做，
   * 因为那需要遍历所有敌人才知道砍到了谁。实体自己不该管别人的事。
   */
  Player.prototype.startAttack = function () {
    const S = this.stats;

    this.attacking = true;
    this.attackTimer = S.atkDuration;
    this.attackCooldown = S.atkCooldown;
    this.swingSeq++;

    // 新的一击，清空上一击打过的敌人
    if (this.hitThisSwing) this.hitThisSwing.clear();

    // ★ 听感也是角色差异的一部分 ★
    // 法师挥杖是"咻"的一声吟唱，战士挥斧是"唰"的破空声。
    // 玩家闭着眼睛都能听出自己玩的是谁，这叫"音频辨识度"。
    DG.Audio.play(S.ranged ? 'cast' : 'swing');

    // ★ 远程角色：不靠近战判定框，而是申请发射一枚投射物 ★
    // 真正的生成在 game.js 里做（理由见 this.pendingShot 的注释）
    if (S.ranged) {
      this.pendingShot = true;
    }
  };

  /** 把朝向转成一个单位向量，方便统一处理"朝哪边" */
  Player.prototype.getFacingVector = function () {
    switch (this.facing) {
      case 'up':    return { x: 0, y: -1 };
      case 'down':  return { x: 0, y: 1 };
      case 'left':  return { x: -1, y: 0 };
      case 'right': return { x: 1, y: 0 };
      default:      return { x: 0, y: 1 };
    }
  };

  /**
   * 计算剑的攻击判定框（一个矩形）。
   *
   * ★ 关键设计：判定框会跟着朝向"变形"★
   * 朝左右时，框是"横长"的（18×14）；
   * 朝上下时，框是"竖长"的（14×18）。
   *
   * 为什么？因为剑是"往前伸"的，横着挥的时候覆盖的横向范围应该更大。
   * 如果四个方向都用同一个正方形框，玩家会明显感觉到
   * "朝上砍好像短了一截"—— 这就是判定和视觉不一致。
   *
   * 游戏设计里有一条铁律：**判定必须和视觉效果一致**。
   * 玩家看到的画面就是他对规则的唯一认知，一旦两者不符，就会觉得"这游戏手感怪"。
   */
  Player.prototype.getAttackBox = function () {
    const S = this.stats;
    const dir = this.getFacingVector();

    // 判定框的中心：从玩家中心往朝向方向推 atkReach 像素
    const cx = this.x + dir.x * S.atkReach;
    const cy = this.y + dir.y * S.atkReach;

    // 横向攻击时宽=atkW、高=atkH；纵向时宽高互换
    const horizontal = (this.facing === 'left' || this.facing === 'right');
    const bw = horizontal ? S.atkW : S.atkH;
    const bh = horizontal ? S.atkH : S.atkW;

    return {
      x: cx - bw / 2,
      y: cy - bh / 2,
      w: bw,
      h: bh,
    };
  };

  /**
   * 根据当前状态选出该画哪个精灵。
   *
   * ★ 动画帧的切换靠"计时器取整"★
   * walkTimer 累加时间，然后 Math.floor(walkTimer / 0.14) % 2 得到 0 或 1。
   * 意思是"每 0.14 秒切换一次帧"，于是走路动画就是 7 帧/秒左右。
   * 这个速度接近老游戏的感觉 —— 太快会显得鬼畜，太慢会显得像幻灯片。
   */
  Player.prototype.updateSprite = function (dt) {
    if (this.moving) {
      this.walkTimer += dt;
    } else {
      this.walkTimer = 0; // 站住时重置，下次起步从 A 帧开始
    }

    // 走路时快速交替 A/B，站着时固定显示 A 帧
    const frame = this.moving ? (Math.floor(this.walkTimer / 0.14) % 2 === 0 ? 'a' : 'b') : 'a';

    // ★ 精灵名字 = 角色id + 方向 + 帧 ★
    // 比如 da_down_a / zu_side_l_b。这个命名规则是和 sprites.js 约定好的，
    // 所以换角色只需要换 charId 这一个字段，绘制代码完全不用动。
    switch (this.facing) {
      case 'up':
        this.sprite = this.charId + '_up_' + frame;
        break;
      case 'left':
        this.sprite = this.charId + '_side_l_' + frame; // 朝左用翻转版本
        break;
      case 'right':
        this.sprite = this.charId + '_side_' + frame;
        break;
      case 'down':
      default:
        this.sprite = this.charId + '_down_' + frame;
        break;
    }
  };

  /**
   * 受到伤害。
   *
   * @param {number} amount 伤害值
   * @param {number} fromX  伤害来源的 x（用来决定击退方向）
   * @param {number} fromY  伤害来源的 y
   * @returns {boolean} 是否真的受伤了（无敌中会返回 false）
   */
  Player.prototype.takeDamage = function (amount, fromX, fromY) {
    // ★ 无敌帧检查 ★
    // 这是最基础也最重要的伤害保护机制。没有它，玩家站在怪堆里
    // 每秒会被扣 60 次血（因为每帧都判定一次碰撞），瞬间暴毙。
    // 加了无敌帧之后，一次接触只扣一次血，玩家有 1 秒时间跑开。
    if (this.invuln > 0) return false;

    // ★ 角色专属：伤害减免（圣骑士的"重甲护体"）★
    //
    // ★ 注意外层那个 Math.max(1, ...) ★
    // 减免必须留一个下限 —— 否则一旦减免值大于等于敌人伤害，
    // 玩家就变成了永久免疫，游戏立刻失去意义。
    // 这种"本意是加强、结果破坏平衡"的数值，做设计时要格外警惕。
    let finalDamage = amount;
    if (this.stats.damageReduce) {
      finalDamage = Math.max(1, amount - this.stats.damageReduce);
    }

    this.hp -= finalDamage;
    this.invuln = DG.PLAYER.INVULN;

    // 击退：从伤害来源"往外推"
    // 用 atan2 算出"从来源指向玩家"的角度，再转成方向向量。
    // 这是个非常常用的三角函数技巧：把一个"方向"变成一个单位向量。
    const dx = this.x - fromX;
    const dy = this.y - fromY;
    const len = Math.sqrt(dx * dx + dy * dy) || 1; // 防除零：|| 1 在 len 为 0 时兜底

    this.kx = (dx / len) * 130;
    this.ky = (dy / len) * 130;

    // 屏幕震动强度（由 game.js 读取并执行）
    DG.shakeAmount = 5;

    DG.Audio.play('hurt');
    return true;
  };

  /** 回血。返回实际回了多少（用不上就返回 0，避免浪费血瓶） */
  Player.prototype.heal = function (amount) {
    const before = this.hp;
    this.hp = DG.min(this.hp + amount, this.maxHp);
    return this.hp - before;
  };

  /** 玩家当前应该画哪个精灵（game.js 渲染时调用） */
  Player.prototype.getSpriteName = function () {
    return this.sprite;
  };

  /**
   * 玩家受伤闪烁时，某些帧应该"隐形"。
   * ★ 闪烁 = 一半时间显示、一半时间不显示 ★
   * 用 (invuln * 14) 取整再判断奇偶，就能做出每秒闪 14 次左右的效果。
   * 这是最经典的"受伤无敌"视觉反馈，几乎所有动作游戏都用它。
   */
  Player.prototype.isFlashing = function () {
    return this.invuln > 0 && Math.floor(this.invuln * 14) % 2 === 1;
  };

  DG.Player = Player;

  // ==========================================================================
  // 四、敌人
  // ==========================================================================

  /** 敌人类型对应的数值表，从 config 里取，避免在这里硬编码数字 */
  const ENEMY_STATS = {
    slime:    DG.ENEMY.SLIME,
    bat:      DG.ENEMY.BAT,
    skeleton: DG.ENEMY.SKELETON,
  };

  /**
   * 敌人实体。
   *
   * @param {number} x
   * @param {number} y
   * @param {string} type 'slime' / 'bat' / 'skeleton'
   * @param {number} floorNum 所在层数（用来做难度缩放）
   */
  function Enemy(x, y, type, floorNum) {
    Entity.call(this, x, y);

    this.type = type;
    const stats = ENEMY_STATS[type] || ENEMY_STATS.slime;

    // ---- 碰撞盒：也是只有脚那么大 ----
    // 史莱姆扁，碰撞盒也矮一点；蝙蝠是飞的，碰撞盒给得小一些。
    if (type === 'slime') {
      this.hw = 4;
      this.hh = 3;
    } else if (type === 'bat') {
      this.hw = 4;
      this.hh = 2; // 蝙蝠在飞，脚下的判定更小
    } else {
      this.hw = 4;
      this.hh = 3;
    }

    // ---- 数值 ----
    // 生命值和伤害会随层数缓慢增长，做出"越往下越难"的感觉。
    // ★ 注意是"缓慢"增长 ★
    // 如果每层翻倍，第 10 层就是 512 倍，直接变成不可能通关。
    // 用 +0.5 这种线性增长，难度曲线才平滑可控。
    const depthBonus = Math.floor((floorNum - 1) * 0.5);

    this.hp = stats.HP + depthBonus;
    this.maxHp = this.hp;
    this.damage = stats.DAMAGE + (floorNum >= 6 ? 1 : 0); // 6 层以后才加伤
    this.speed = stats.SPEED;
    this.knockbackPower = stats.KNOCKBACK;
    this.score = stats.SCORE;

    this.sprite = type + '_a';

    // ---- AI 状态 ----
    this.aggro = false;         // 是否已经发现玩家
    this.wanderAngle = DG.randFloat(0, Math.PI * 2); // 游荡方向
    this.wanderTimer = DG.randFloat(0.5, 2);         // 还有多久换个方向

    // ---- 动画 ----
    // 初始相位随机，这样同一群敌人不会"整整齐齐同时跳"，
    // 看起来更自然。这个技巧叫"去同步化"，很小的一个改动，观感提升明显。
    this.animT = DG.randFloat(0, 1.4);

    // ---- 蝙蝠专属：飞行摆动相位 ----
    this.flutterPhase = DG.randFloat(0, Math.PI * 2);
  }
  Enemy.prototype = Object.create(Entity.prototype);
  Enemy.prototype.constructor = Enemy;

  /**
   * 敌人 AI 更新。
   *
   * ★ 这个 AI 非常简单，但已经足够"看起来聪明" ★
   *
   * 规则只有三条：
   *   1. 玩家在感知范围内 → 直线冲向玩家
   *   2. 玩家不在范围内 → 随机游荡
   *   3. 永远不穿过墙（靠碰撞系统保证）
   *
   * 对玩家来说，这个 AI 产生的行为是"会追我的怪"，
   * 已经完全足够形成游戏压力了。**不要过早追求复杂 AI** ——
   * 大部分游戏里的敌人 AI 都是十几行代码，玩家的想象力会补足剩下的部分。
   *
   * @param {number} dt
   * @param {object} map
   * @param {Player} player 用来判断距离和方向
   * @param {Array} others 其他敌人（用于互相分离）
   */
  Enemy.prototype.update = function (dt, map, player, others) {
    this.tickAnim(dt);
    this.animT += dt;

    // ---- 判断玩家是否在感知范围内 ----
    const dx = player.x - this.x;
    const dy = player.y - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    this.aggro = dist < DG.ENEMY.AGGRO_RANGE;

    if (this.aggro && dist > 0.001) {
      // ---- 追击：朝玩家方向走 ----
      let mx = dx / dist;
      let my = dy / dist;

      // ★ 蝙蝠的专属行为：正弦摆动 ★
      // 让蝙蝠的飞行轨迹加一个垂直方向的左右摆动，
      // 看起来就像"扑棱扑棱"地飞，而不是像块石头直线砸过来。
      // 用 sin 函数，是因为它的周期性和平滑性天然适合做"来回摆动"。
      if (this.type === 'bat') {
        this.flutterPhase += dt * 9; // 摆动频率
        const perpX = -my; // 垂直于飞行方向的向量（法向量）
        const perpY = mx;
        const sway = Math.sin(this.flutterPhase) * 0.55; // 摆动幅度
        mx += perpX * sway;
        my += perpY * sway;
      }

      this.vx = mx * this.speed;
      this.vy = my * this.speed;
    } else {
      // ---- 游荡：隔一段时间换个方向 ----
      this.wanderTimer -= dt;
      if (this.wanderTimer <= 0) {
        this.wanderTimer = DG.randFloat(0.6, 2.2);
        this.wanderAngle = DG.randFloat(0, Math.PI * 2);
      }

      // 游荡速度比追击速度慢很多（45%），
      // 这样玩家一眼就能看出"这只怪发现我了"——速度突变本身就是最强的信息传达。
      this.vx = Math.cos(this.wanderAngle) * this.speed * 0.45;
      this.vy = Math.sin(this.wanderAngle) * this.speed * 0.45;
    }

    // ---- 分离力：不让敌人挤成一坨 ----
    // 见文件头的"概念 3"
    if (others && others.length > 1) {
      let sepX = 0;
      let sepY = 0;
      const minDist = DG.ENEMY.SEPARATION;

      for (let i = 0; i < others.length; i++) {
        const o = others[i];
        if (o === this || o.dead) continue;

        const ox = this.x - o.x;
        const oy = this.y - o.y;
        const od = Math.sqrt(ox * ox + oy * oy);

        // 只有靠得太近才推开；距离为 0 时随便给个方向避免除零
        if (od < minDist && od > 0.001) {
          // 越近推得越用力：(1 - od/minDist) 在贴在一起时接近 1，刚好到边界时接近 0。
          // 这个"距离越近力越大"的公式是分离力的标准写法。
          const push = (1 - od / minDist) * 40;
          sepX += (ox / od) * push;
          sepY += (oy / od) * push;
        }
      }

      this.vx += sepX;
      this.vy += sepY;
    }

    // ---- 应用移动 ----
    this.applyKnockbackDecay(dt);
    this.integrate(map, dt);

    // ---- 选动画帧 ----
    // 所有敌人都用同一套规则：每 0.2 秒切换一次 A/B 帧
    const frame = (Math.floor(this.animT / 0.2) % 2 === 0) ? 'a' : 'b';
    this.sprite = this.type + '_' + frame;
  };

  /**
   * 敌人受伤。
   *
   * @param {number} amount 伤害
   * @param {number} fromX  攻击来自哪（决定击退方向）
   * @param {number} fromY
   * @returns {boolean} 这一击是否杀死了它
   */
  Enemy.prototype.takeDamage = function (amount, fromX, fromY) {
    this.hp -= amount;
    this.hitFlash = 0.09; // 白闪 90 毫秒 —— 短到几乎看不见，但眼睛能感觉到

    // 击退：从攻击者方向往外推
    const dx = this.x - fromX;
    const dy = this.y - fromY;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;

    this.kx = (dx / len) * this.knockbackPower;
    this.ky = (dy / len) * this.knockbackPower;

    if (this.hp <= 0) {
      this.dead = true;
      return true;
    }
    return false;
  };

  /** 敌人被踩死/打死时应该掉什么（返回一个道具类型或 null） */
  Enemy.prototype.getDrop = function () {
    // 蝙蝠速度快、难打，所以掉金币概率更高，作为"高风险高回报"的鼓励。
    // 这是很典型的设计手法：奖励和难度挂钩，玩家才会主动挑战强敌。
    const chance = (this.type === 'bat') ? 0.55 : (this.type === 'skeleton' ? 0.7 : 0.3);
    return Math.random() < chance ? 'coin' : null;
  };

  DG.Enemy = Enemy;

  // ==========================================================================
  // 五、道具
  // ==========================================================================

  /**
   * 道具实体（金币 / 血瓶）。
   *
   * 道具和其它实体最大的不同是：它**不移动**，只是原地上下浮动。
   * 但为了复用 Entity 的位置/碰撞盒逻辑，还是继承它。
   */
  function Item(x, y, type) {
    Entity.call(this, x, y);

    this.type = type; // 'coin' 或 'potion'
    this.hw = 5;      // 拾取判定给得比较宽松，玩家不容易"擦肩而过没捡到"
    this.hh = 5;
    this.collected = false;

    // 浮动动画的随机相位：让每个道具浮动的节奏都不一样，
    // 一堆金币在同一间房里此起彼伏，画面立刻就活了。
    this.bobPhase = DG.randFloat(0, Math.PI * 2);

    this.sprite = (type === 'coin') ? 'coin_a' : 'potion';
  }
  Item.prototype = Object.create(Entity.prototype);
  Item.prototype.constructor = Item;

  Item.prototype.update = function (dt) {
    this.animT += dt;

    // 金币自转：0.3 秒切一次正/侧面
    if (this.type === 'coin') {
      const frame = (Math.floor(this.animT / 0.3) % 2 === 0) ? 'a' : 'b';
      this.sprite = 'coin_' + frame;
    }
    // 血瓶不做动画，静态就好 —— 道具中"会动的"应该比"不动的"更吸引注意，
    // 而金币是次要奖励、血瓶是关键资源，所以这个视觉优先级刚好是反的。
    // （如果你想让血瓶更醒目，可以给它加个发光脉冲）
  };

  /** 道具上下浮动的偏移量，渲染时加上去 */
  Item.prototype.getBobOffset = function () {
    return Math.sin(this.bobPhase + this.animT * 3) * 1.5;
  };

  DG.Item = Item;

  // ==========================================================================
  // 五之二、投射物（法师的火球）
  // ==========================================================================

  /**
   * 一枚会飞的伤害源。
   *
   * ★ 它和"近战判定框"的本质区别是什么？★
   *
   * 近战判定框是**瞬间的、跟着角色走的**：按下攻击键的那一瞬间，
   * 在角色前方凭空检查一次有没有敌人，检查完就没了。
   *
   * 而投射物是一个**真正存在于世界里的独立物体**：它有自己的位置和速度，
   * 要一帧一帧地飞，会撞墙、会飞过头、也会在半路打中突然冒出来的敌人。
   *
   * 这个区别直接决定了两种完全不同的玩法：
   *   近战 = 必须贴脸，风险高、但爆发即时
   *   远程 = 可以放风筝拉扯，但要预判走位，打不中就是白白浪费一次输出
   *
   * @param {number} x 出生位置
   * @param {number} y
   * @param {number} vx 速度（像素/秒）
   * @param {number} vy
   * @param {number} damage 命中后造成多少伤害
   * @param {number} range  飞多远之后自行消散（防止火球飞遍全图）
   */
  function Projectile(x, y, vx, vy, damage, range) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.damage = damage;
    this.range = range;
    this.traveled = 0;   // 已经飞了多远
    this.dead = false;
    this.animT = 0;      // 动画计时（火球会自己一闪一闪地脉动）
  }

  Projectile.prototype.update = function (dt, map) {
    const dx = this.vx * dt;
    const dy = this.vy * dt;

    this.x += dx;
    this.y += dy;
    this.animT += dt;

    // 累计飞行距离。用实际位移来算，所以即使以后让火球拐弯也不会算错。
    this.traveled += Math.sqrt(dx * dx + dy * dy);

    // ★ 飞够远就消散 ★
    // 没有这条，法师站在房间一头就能清空整张地图，游戏毫无张力。
    if (this.traveled >= this.range) {
      this.dead = true;
      return;
    }

    // ★ 撞墙就炸 —— 这条比上一条更重要 ★
    // 没有它，火球会直接穿墙飞过去打死墙背后的敌人，
    // 玩家看到只会觉得"这游戏坏了"。
    if (DG.Collision.isSolidAt(map, this.x, this.y)) {
      this.dead = true;
    }
  };

  DG.Projectile = Projectile;

  // ==========================================================================
  // 六、粒子特效
  // ==========================================================================

  /**
   * 粒子：一个会飞散、会消失的小方块。
   *
   * ★ 粒子是"廉价的高级感"★
   * 命中时炸出 5 个粒子，成本几乎为零，但玩家感受到的"打击反馈"提升巨大。
   * 几乎所有现代游戏都大量使用粒子特效来强化每一次交互。
   *
   * 实现上粒子极其简单：位置 + 速度 + 寿命，每帧移动、每帧减少寿命，
   * 寿命到了就消失。
   */
  function Particle(x, y, vx, vy, life, color, size) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.life = life;       // 还能活多久（秒）
    this.maxLife = life;    // 出生时的寿命（用来算透明度）
    this.color = color;
    this.size = size || 2;
    this.dead = false;
  }

  Particle.prototype.update = function (dt) {
    this.life -= dt;
    if (this.life <= 0) {
      this.dead = true;
      return;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // 粒子受"阻力"影响不断减速，飞出去后自然停下来
    const decay = Math.pow(0.02, dt);
    this.vx *= decay;
    this.vy *= decay;
  };

  /** 粒子越接近死亡越透明，做出"淡出"效果 */
  Particle.prototype.getAlpha = function () {
    return DG.clamp(this.life / this.maxLife, 0, 1);
  };

  /**
   * 造一堆粒子（命中特效）。
   *
   * @param {number} x 炸开的中心
   * @param {number} y
   * @param {number} count 几个粒子
   * @param {string} color 颜色
   * @param {number} speed 飞散速度
   * @param {Array} out 存放到哪个数组里
   */
  DG.spawnBurst = function (x, y, count, color, speed, out) {
    for (let i = 0; i < count; i++) {
      // 均匀分布在 360° 上，再叠加一点随机，形成"炸开"的观感
      const angle = (i / count) * Math.PI * 2 + DG.randFloat(-0.4, 0.4);
      const spd = speed * DG.randFloat(0.5, 1.3);
      out.push(new Particle(
        x,
        y,
        Math.cos(angle) * spd,
        Math.sin(angle) * spd,
        DG.randFloat(0.2, 0.45),
        color,
        DG.randInt(1, 3)
      ));
    }
  };

  DG.Particle = Particle;

  // ==========================================================================
  // 七、导出碰撞工具给 game.js 用
  // ==========================================================================

  DG.Collision = {
    boxHitsWall: boxHitsWall,
    moveWithCollision: moveWithCollision,
    rectsOverlap: rectsOverlap,
    isSolidAt: isSolidAt,
  };

  /** 屏幕震动强度，被 Player.takeDamage 和游戏逻辑写入，game.js 读取 */
  DG.shakeAmount = 0;

})(window.DG);
