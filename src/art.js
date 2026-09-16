/*
  ============================================================================
  文件：src/art.js —— 像素美术数据（游戏里所有"角色长什么样"）
  ============================================================================

  【这个文件是干嘛的？】
  它只有数据，没有一行逻辑。里面全是一个个字符串数组，
  每个字符串代表精灵的一行像素，每个字符代表一个颜色。

  【你会学到什么？—— "字符画"是纯代码像素美术的最佳方案】

  先看一颗金币（8 像素宽）：

      '..kkkk..'
      '.kyyyyk.'
      'kyywwyyk'
      '..kkkk..'

  '.' 是透明，'k' 是黑色描边，'y' 是金色，'w' 是高光。
  你盯着这几个字符串看，其实已经能"看见"金币的形状了 ——
  这就是字符画最妙的地方：**美术和数据是同一份东西**。

  对比另一种写法（直接给每个像素写坐标）：
      fillRect(2,0,4,1); fillRect(1,1,6,1); ...
  同样是画金币，你根本看不出画的是什么，想改更是一场灾难。

  老游戏和大量独立游戏都用这个方案（专业叫法：ASCII art sprite）。

  【怎么读这些图？】
  - 一个数组 = 一个精灵；数组里每个字符串 = 一行像素，从上往下
  - 所有字符串长度必须完全相等，这个长度就是精灵宽度
  - 数组长度 = 精灵高度
  - 字符含义见下面的 CHARS 表
  - 名字带 A / B 后缀的是动画的两帧：播放时 A→B→A→B 循环就成了动画

  【阅读建议】
  先看 CHARS 表，然后挑 SLIME（最简单的一个）试着在脑子里渲染出来，
  最后跳到 sprites.js 看这些字符串是怎么变成真正的 Canvas 图像的。
  ============================================================================
*/

(function (DG) {
  'use strict';

  // ==========================================================================
  // 一、颜色字典
  // ==========================================================================

  /**
   * 字符 → 颜色 的对照表，所有精灵共用这一张。
   *
   * ★ 为什么共用而不是每个精灵配一份？★
   * 共用能保证全局颜色统一（同一个 'r' 到处都是同一种红），画面整体感更强。
   * 这也是专业像素美术的工作方式：先定一个 16~32 色的调色板，
   * 然后全程只用这些颜色，绝对不临时"随手挑个红"。
   *
   * 值为 null 表示"透明，这个像素不画"——
   * 这是精灵能有形状轮廓的关键，否则每个角色都会是一个实心方块。
   */
  const CHARS = {
    '.': null,               // 透明（注意不是白色，是"这里什么都没有"）
    'k': DG.PALETTE.ink,     // 黑：描边，让角色从背景里"跳"出来
    'f': DG.PALETTE.skin,    // 肤色亮面
    'F': DG.PALETTE.skinD,   // 肤色暗面
    'b': DG.PALETTE.cloth,   // 衣服蓝（亮）
    'B': DG.PALETTE.clothD,  // 衣服蓝（暗）
    'n': DG.PALETTE.wood,    // 棕：头发 / 靴子 / 木塞
    'y': DG.PALETTE.gold,    // 金黄
    'd': DG.PALETTE.goldD,   // 暗金
    'w': DG.PALETTE.white,   // 白：高光 / 眼白
    'g': DG.PALETTE.slime,   // 史莱姆绿
    'G': DG.PALETTE.slimeD,  // 史莱姆暗绿
    'p': DG.PALETTE.batB,    // 蝙蝠紫
    'P': DG.PALETTE.batD,    // 蝙蝠暗紫
    'o': DG.PALETTE.bone,    // 骨白
    'O': DG.PALETTE.boneD,   // 骨暗
    'r': DG.PALETTE.red,     // 红：血 / 心
    'R': DG.PALETTE.redD,    // 深红（空心的颜色）
    'm': DG.PALETTE.pink,    // 粉：血瓶液体
    'M': DG.PALETTE.pinkL,   // 浅粉高光
    'c': DG.PALETTE.cyan,    // 青：楼梯光效

    // ---- 四名可选角色的专属色（色值定义在 config.js 的 PALETTE 里）----
    // ★ 字符大小写的规律不是随便定的 ★
    // 这里沿用了上面 b/B、g/G、p/P 的老规矩：**小写 = 亮面，大写 = 暗面**。
    // 保持这个规律，回头看字符画时一眼就能判断哪块是受光面、哪块是背光面。
    'a': DG.PALETTE.berserk,  // 狂战士皮甲（亮）
    'A': DG.PALETTE.berserkD, // 狂战士皮甲（暗）
    'e': DG.PALETTE.robe,     // 法师长袍（亮）
    'E': DG.PALETTE.robeD,    // 法师长袍（暗）
    'v': DG.PALETTE.ranger,   // 游侠斗篷（亮）
    'V': DG.PALETTE.rangerD,  // 游侠斗篷（暗）
    'u': DG.PALETTE.plate,    // 骑士金甲（亮）
    'U': DG.PALETTE.plateD,   // 骑士金甲（暗）
    'q': DG.PALETTE.steel,    // 钢：头盔、剑刃
  };

  // ==========================================================================
  // 二、四名可选角色（每个都是 12×14）
  // ==========================================================================

  /**
   * ★ 尺寸为什么选 12×14？★
   * 地砖是 16×16，角色比格子略小一圈，走位时视觉上"有余量"，
   * 不会出现"看着明明没碰到墙却卡住了"的别扭感。这叫判定宽容度。
   *
   * ★ 为什么只有下 / 上 / 右三个方向？★
   * 因为"朝左"就是"朝右"左右翻转。横向翻转是零成本的，
   * 所以我们只需要画一个侧身，左右两边都够用了（见 sprites.js 的 flip）。
   *
   * ---------------------------------------------------------------------------
   * ★ 四个角色的外形设计思路 ★
   * ---------------------------------------------------------------------------
   * 角色在画面上只有 12×14 = 168 个像素。想把四个角色画得"一眼能分辨"，
   * 靠细节是没用的 —— 必须靠**大块的色块和剪影差别**。
   * 所以每个角色都只抓一个最抢眼的特征：
   *
   *   大  → 光头 + 大胡子 + 特别宽的肩膀（剪影最"横"）
   *   祖  → 高尖帽，比别人高出一截（剪影最高）+ 白胡子
   *   马  → 兜帽罩住上半张脸，只有脸中间露出一小条肤色
   *   金  → 钢盔 + 金甲，唯一带冷灰 + 暖金对比的角色
   *
   * 这就是角色设计里常说的"剪影测试"：
   * 把画面调成纯黑只看轮廓，仍然能分清谁是谁，才算设计成功。
   */
  const DA = {
    leg: 'aA',
    boot: 'nn',
    // ----------------------------------------------------------------------
    // 大 · 狂战士：光头、络腮胡、赭红皮甲。
    // 【面朝下】镜头在玩家斜上方，所以能看到脸。
    // ----------------------------------------------------------------------
    downA: [
      '....kkkk....',
      '...kffffk...', // 光头：头顶是肤色，没有头发
      '..kffffffk..',
      '..kfkffkfk..', // 两只眼睛
      '..kffffffk..',
      '..knnnnnnk..', // 络腮胡
      '...knnnnk...', // 胡子向下收窄
      '.kaaaaaaaak.', // ★ 肩膀从这里就比标准角色宽 1 格
      'kaaaaaaaaaak', // 最宽的一行 —— 魁梧感全靠它
      'kfaaaaaaaafk', // 两侧露出的 f 是垂下来的手
      'kfaaaaaaaafk',
      '.kaaaaaaaak.',
      '..kaAkkAak..',
      '..knnk.knnk.',
    ],
    upA: [
      '....kkkk....',
      '...kffffk...', // 从背后看，光头同样是肤色
      '..kffffffk..',
      '..kffffffk..',
      '..kffffffk..',
      '..kffffffk..',
      '..kffffffk..',
      '...kFFFFk...', // 后颈的阴影
      '.kaaaaaaaak.',
      'kaaaaaaaaaak',
      'kaaaaaaaaaak',
      '.kaaaaaaaak.',
      '..kaAkkAak..',
      '..knnk.knnk.',
    ],
    sideA: [
      '....kkkk....',
      '...kffffk...',
      '..kffffffk..',
      '..kffffkfk..', // 侧脸只能看到一只眼睛，靠右
      '..kffffffk..',
      '..knnnnnnk..',
      '...knnnnk...',
      '.kaaaaaaaak.',
      '.kaaaaaaaak.',
      '.kaaaaaaafk.', // 朝前伸出的手臂
      '.kaaaaaaafk.',
      '.kaaaaaaaak.',
      '..kaAkkAak..',
      '..knnk.knnk.',
    ],
  };

  /** 祖 · 秘法师：高尖帽、白胡子、紫色长袍 */
  const ZU = {
    leg: 'EE',
    boot: 'nn',
    downA: [
      '.....kk.....', // 帽尖
      '....keek....',
      '...keeeek...',
      '..keeeeeek..',
      '.kkkkkkkkkk.', // 帽檐：一整条黑线，把帽子"压"在头上
      '..kffffffk..',
      '..kfkffkfk..',
      '..kffffffk..',
      '..kwwwwwwk..', // 白胡子
      '..keeeeeek..',
      '.keeeeeeeek.',
      '.keeeeeeeek.',
      '..keeeeeek..',
      '..kEEkkEEk..',
    ],
    upA: [
      '.....kk.....',
      '....keek....',
      '...keeeek...',
      '..keeeeeek..',
      '.kkkkkkkkkk.',
      '..keeeeeek..', // 背面全是帽子和袍子，看不到脸
      '..keeeeeek..',
      '..keeeeeek..',
      '..keeeeeek..',
      '.keeeeeeeek.',
      '.keeeeeeeek.',
      '.keeeeeeeek.',
      '..keeeeeek..',
      '..kEEkkEEk..',
    ],
    sideA: [
      '.....kk.....',
      '....keek....',
      '...keeeek...',
      '..keeeeeek..',
      '.kkkkkkkkkk.',
      '..kffffffk..',
      '..kffffkfk..',
      '..kffffffk..',
      '..kwwwwwwk..',
      '..keeeeeek..',
      '..keeeeeek..',
      '..keeeeeek..',
      '..keeeeeek..',
      '..kEEkkEEk..',
    ],
  };

  /** 马 · 游侠：兜帽罩头、青绿斗篷，四肢最轻快 */
  const MA = {
    leg: 'VV',
    boot: 'nn',
    downA: [
      '....kkkk....',
      '...kvvvvk...',
      '..kvvvvvvk..',
      '..kvffffvk..', // ★ 兜帽里露出的脸：左右两侧被 v 夹住
      '..kvfkffkv..', // 眼睛（两侧依然是兜帽，所以脸很窄）
      '..kvffffvk..',
      '...kvvvvk...', // 兜帽收口
      '..kvvvvvvk..',
      '.kvvvvvvvvk.',
      '.kfvvvvvvfk.',
      '.kfvvvvvvfk.',
      '..kvvvvvvk..',
      '..kVVkkVVk..',
      '..knnk.knnk.',
    ],
    upA: [
      '....kkkk....',
      '...kvvvvk...',
      '..kvvvvvvk..',
      '..kvvvvvvk..',
      '..kvvvvvvk..',
      '..kvvvvvvk..',
      '..kvvvvvvk..',
      '...kvvvvk...',
      '..kvvvvvvk..',
      '.kvvvvvvvvk.',
      '.kvvvvvvvvk.',
      '.kvvvvvvvvk.',
      '..kvvvvvvk..',
      '..kVVkkVVk..',
    ],
    sideA: [
      '....kkkk....',
      '...kvvvvk...',
      '..kvvvvvvk..',
      '..kvffffk...', // 侧脸从兜帽里露出半张
      '..kvffkfk...',
      '..kvffffk...',
      '...kvvvvk...',
      '..kvvvvvvk..',
      '..kvvvvvvvk.',
      '..kvvvvvvfk.', // 朝前伸出的手臂
      '..kvvvvvvfk.',
      '..kvvvvvvk..',
      '..kVVkkVVk..',
      '..knnk.knnk.',
    ],
  };

  /** 金 · 圣骑士：钢盔、金甲，全场最"重"的剪影 */
  const JIN = {
    leg: 'uU',
    boot: 'nn',
    downA: [
      '....kkkk....',
      '...kqqqqk...', // 钢盔
      '..kqqqqqqk..',
      '..kqffffqk..', // 盔缝里露出的脸
      '..kqfkfkqk..',
      '..kqffffqk..',
      '...kqqqqk...', // 护颈
      '..kuuuuuuk..',
      '.kuuuuuuuuk.',
      '.kfuuuuuufk.',
      '.kfuuuuuufk.',
      '..kuuuuuuk..',
      '..kuUkkUuk..',
      '..knnk.knnk.',
    ],
    upA: [
      '....kkkk....',
      '...kqqqqk...',
      '..kqqqqqqk..',
      '..kqqqqqqk..', // 背面是一整顶头盔，看不到脸
      '..kqqqqqqk..',
      '..kqqqqqqk..',
      '..kqqqqqqk..',
      '...kqqqqk...',
      '..kuuuuuuk..',
      '.kuuuuuuuuk.',
      '.kuuuuuuuuk.',
      '.kuuuuuuuuk.',
      '..kuuuuuuk..',
      '..kuUkkUuk..',
    ],
    sideA: [
      '....kkkk....',
      '...kqqqqk...',
      '..kqqqqqqk..',
      '..kqffffk...',
      '..kqffkfk...',
      '..kqffffk...',
      '...kqqqqk...',
      '..kuuuuuuk..',
      '..kuuuuuuuk.',
      '..kuuuuuufk.', // 朝前伸出的持剑手臂
      '..kuuuuuufk.',
      '..kuuuuuuk..',
      '..kuUkkUuk..',
      '..knnk.knnk.',
    ],
  };

  /**
   * ★ 由"站立帧"自动推出"走路帧" ★
   *
   * 仔细观察任何角色的站立帧和走路帧，会发现它们**只有最后两行不一样**：
   * 站立时两条腿并拢，走路时两条腿分开。
   *
   * 如果老老实实把两个姿势都手写一遍，四个角色就是 4 × 3 × 2 = 24 份数据，
   * 其中整整一半是完全重复的。更糟的是：以后想把靴子改成赤脚，
   * 你得记得改 12 个地方，漏一个就会出现"一条腿穿鞋、一条腿光着"的画面。
   *
   * 所以这里用代码生成：只要告诉它腿和靴子用什么颜色，它自己拼出迈腿的姿势。
   * 这叫**用规则替代重复数据** —— 是消灭"抄写错误"最有效的手段。
   *
   * @param {string[]} rows    站立帧
   * @param {string} legPair   一条腿的两个颜色字符（亮+暗），比如 'aA'
   * @param {string} bootPair  一只靴子的两个字符，通常就是 'nn'
   */
  function walkFrame(rows, legPair, bootPair) {
    const r = rows.slice(); // 先复制一份，绝不能改到原数组（否则站立帧也被改了）
    const n = r.length;

    // 倒数第二行：两条腿，从"并拢"改成"分开"
    r[n - 2] = '.k' + legPair + 'k..k' + legPair + 'k.';
    // 最后一行：两只靴子，同样分开
    r[n - 1] = '.k' + bootPair + 'k..k' + bootPair + 'k.';

    return r;
  }

  /** 把一份"三方向站立帧"扩写成完整的六帧（自动补出走路帧） */
  function buildSet(def) {
    return {
      downA: def.downA,
      downB: walkFrame(def.downA, def.leg, def.boot),
      upA: def.upA,
      upB: walkFrame(def.upA, def.leg, def.boot),
      sideA: def.sideA,
      sideB: walkFrame(def.sideA, def.leg, def.boot),
    };
  }

  /**
   * 四套角色外形。键名（da/zu/ma/jin）必须和 config.js 里
   * DG.CHARACTERS 的 id 一一对应 —— 因为精灵名字就是用它拼出来的
   * （比如 da_down_a），这是"数据"和"美术"之间唯一的接头暗号。
   */
  const CHARACTER_ART = {
    da: buildSet(DA),
    zu: buildSet(ZU),
    ma: buildSet(MA),
    jin: buildSet(JIN),
  };

  // ==========================================================================
  // 三、敌人
  // ==========================================================================

  /**
   * 史莱姆（10×8）：游戏里最经典的入门怪。
   *
   * ★ 它的存在意义是"教会玩家战斗节奏"★
   * 移动慢、血厚、伤害低，玩家可以放心地在它身上练习挥剑的时机和距离，
   * 而不会因为一次失误就死掉。好的游戏设计会刻意安排这种"教学怪"。
   *
   * 动画是经典的"果冻压缩"：A 帧矮胖、B 帧瘦高，
   * 循环播放就像在弹跳。这是用 2 帧做出"有弹性"感觉的标准手法。
   */
  const SLIME = {
    // A 帧：趴着的状态（宽而矮）
    A: [
      '...kkkk...',
      '..kggggk..',
      '.kggggggk.',
      '.kwggggwk.', // 两只白色小眼睛
      'kggggggggk',
      'kggggggggk',
      'kGggggggGk', // 底部颜色变暗，做出体积感
      '.kkkkkkkk.', // 贴地的阴影边
    ],
    // B 帧：弹起来的状态（窄而高，底部收紧）
    B: [
      '..........', // 整体上移一格 = 跳起来了
      '...kkkk...',
      '..kggggk..',
      '.kwggggwk.',
      'kggggggggk',
      'kggggggggk',
      'kGggggggGk',
      'kGGGGGGGGk', // 底部压得更扁更暗，强调"落地挤压"
    ],
  };

  /**
   * 蝙蝠（12×8）：高速冲刺型敌人。
   *
   * ★ 它的存在意义是"逼玩家学会走位"★
   * 速度快、血很薄（2 点，一剑就死），但如果你站着不动跟它对拼，
   * 它会先咬到你。所以玩家必须学会"打一下退一步"的节奏。
   *
   * 动画是翅膀上下扇：A 帧翅膀展开、B 帧翅膀收起。
   */
  const BAT = {
    // A 帧：翅膀向两侧展开（飞行的最低点）
    A: [
      '....k..k....', // 顶上的两个 k 是尖耳朵
      '...kppppk...',
      '...kpwwpk...', // 白色眼睛
      'kkk.pppp.kkk', // 翅膀摊开
      'kpp.pppp.ppk',
      'kk..pppp..kk',
      '....pppp....', // 身体
      '.....kk.....', // 脚
    ],
    // B 帧：翅膀收起（飞行的最高点），身体保持不动
    B: [
      '....k..k....',
      '...kppppk...',
      '...kpwwpk...',
      '...kppppk...', // 翅膀收到身体两侧
      '.kk.pppp.kk.',
      'kpp.pppp.ppk',
      'kk..pppp..kk',
      '....kkkk....',
    ],
  };

  /**
   * 骷髅兵（12×14）：中期出现的硬骨头。
   *
   * ★ 它的存在意义是"制造压力峰值"★
   * 血厚（7 点）、伤害高（2 点）、速度中等，而且它会**成群出现**。
   * 玩家遇到它就必须做选择：是硬拼、还是绕开去下一层？
   * 这种"资源 vs 风险"的取舍，就是 roguelike 的核心乐趣。
   *
   * 画法要点：整身只有骨白 'o' 和骨暗 'O' 两种主色，
   * 靠肋骨之间的黑色缝隙来表现"骷髅"的质感。
   */
  const SKELETON = {
    A: [
      '...kkkkk....',
      '..koooook...',
      '..kooooook..',
      '..kokookok..', // 两个黑色的眼窝
      '..kooooook..',
      '...kooook...',
      '....kook....', // 细脖子
      '.kkooooookk.', // 肩胛骨
      '.kkkooookkk.', // 肋骨（两侧的 k 是骨缝）
      '.kkkooookkk.',
      '..kkooookk..', // 腰
      '..koo.ook...', // 骨盆
      '..kok..kok..', // 腿骨
      '..kkk..kkk..', // 脚
    ],
    B: [
      '...kkkkk....',
      '..koooook...',
      '..kooooook..',
      '..kokookok..',
      '..kooooook..',
      '...kooook...',
      '....kook....',
      '.kkooooookk.',
      '.kkkooookkk.',
      '.kkkooookkk.',
      '..kkooookk..',
      '..koo.ook...',
      '.kok....kok.', // 腿骨岔开 = 走路
      '.kkk....kkk.',
    ],
  };

  // ==========================================================================
  // 四、道具
  // ==========================================================================

  /**
   * 金币（8×8）：分数道具。
   *
   * 动画是"旋转"：A 帧是正面（宽），B 帧是侧面（窄），
   * 循环播放就像金币在原地转动。这是用 2 帧做旋转的经典手法 ——
   * 老游戏里几乎所有的"旋转金币"都是这么做的。
   */
  const COIN = {
    A: [
      '..kkkk..',
      '.kyyyyk.',
      'kyywwyyk', // 中间两列白色是金属反光
      'kyywwyyk',
      'kyywwyyk',
      '.kyyyyk.',
      '..kkkk..',
      '........', // 最后一行留空，让硬币在格子里"悬浮"一点
    ],
    B: [
      '...kk...', // 侧面视角，整体窄了 2 像素
      '..kyyk..',
      '.kywwyk.',
      '.kywwyk.',
      '.kywwyk.',
      '..kyyk..',
      '...kk...',
      '........',
    ],
  };

  /**
   * 血瓶（8×10）：恢复生命的道具。
   *
   * 画法要点：顶部用棕色 'n' 画出木塞，瓶身用粉色，
   * 中间用大片浅粉 'M' 做"液体反光" ——
   * 有了这片反光，瓶子立刻就从"粉色方块"变成了"玻璃瓶"。
   * 这就是像素美术里"高光"的价值：很少的几个像素，决定材质感。
   */
  const POTION = [
    '...kk...',
    '..knnk..', // 木塞
    '..kmmk..', // 细瓶颈
    '.kmmmmk.',
    'kmmMMmmk',
    'kmMMMMmk', // 大面积高光 = 玻璃质感
    'kmMMMMmk',
    'kmmMMmmk',
    '.kmmmmk.',
    '..kkkk..', // 瓶底
  ];

  // ==========================================================================
  // 五、HUD 元素（界面上的小图标）
  // ==========================================================================

  /**
   * 心形（7×6）：显示玩家生命值。
   *
   * ★ 为什么用心形而不是数字或血条？★
   * 心形是"离散的生命值"，比"87/100"这种数字更有游戏感，也更一眼可读 ——
   * 玩家不需要思考，扫一眼就知道自己还剩几条命。
   * 这是从《塞尔达传说》开始就定下来的经典设计。
   *
   * 两帧分别是"满心"和"空心"（受伤后显示的颜色）。
   */
  const HEART = {
    full: [
      '.rr.rr.', // 顶部两个凸起 = 心形的两个圆弧
      'rrrrrrr',
      'rrrrrrr',
      '.rrrrr.', // 往下收窄
      '..rrr..',
      '...r...', // 尖端
    ],
    empty: [
      '.RR.RR.',
      'RRRRRRR',
      'RRRRRRR',
      '.RRRRR.',
      '..RRR..',
      '...R...',
    ],
  };

  // ==========================================================================
  // 六、汇总导出
  // ==========================================================================

  /**
   * 把上面所有东西打包成一个对象，挂到 DG.ART 上给 sprites.js 用。
   *
   * ★ 这一步为什么必须做？★
   * 整个文件被包在一个立即执行函数里，里面的 PLAYER、SLIME 等
   * 都是"私有"的，外部看不见（这叫闭包）。想让 sprites.js 用到它们，
   * 就必须像这样主动挂到一个双方都能访问的对象（DG）上。
   */
  DG.ART = {
    CHARS: CHARS,
    CHARACTERS: CHARACTER_ART,
    SLIME: SLIME,
    BAT: BAT,
    SKELETON: SKELETON,
    COIN: COIN,
    POTION: POTION,
    HEART: HEART,
  };

})(window.DG);
