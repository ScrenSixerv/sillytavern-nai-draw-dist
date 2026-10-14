// Nai2API 酒馆助手生图脚本 v31（调试版：DEBUG 已开启，会输出完整日志）
// 作者: glm5.2 glm5.3 deepseek-v4.1-flash claude-opus-5.5
// 依赖: JS-Slash-Runner (TavernHelper) + SillyTavern >= 1.12.14   API: https://nai.sta1n.cn
// 安装、用法与调试说明见仓库 README；排查问题：把下方的 DEBUG 改为 true

(function () {
    'use strict';

    // ─────────────────────────────────────────────────────────────
    // [0] 调试开关与热点优化
    // ─────────────────────────────────────────────────────────────
    // DEBUG：控制台调试日志总开关
    //   true  = 输出完整排查信息：发送给 AI 的完整 sysPrompt（含整段情节上下文）、
    //           AI 原始输出、发送给生图模型的完整 prompt 与 negative——**不截断**
    //   false = 日常使用（默认）：只留一行加载提示，其余全部不输出
    //   注意：DEBUG 开启时单条日志可达上万字符，浏览器开发者工具会把这些字符串留在
    //   内存里；长时间挂机 + 自动生图会持续占用内存，排查完记得改回 false
    const DEBUG = true;   // 分发用调试版：日志默认开启

    function dlog() {
        if (DEBUG && typeof console !== 'undefined') console.log.apply(console, arguments);
    }

    // 全局变量读取缓存
    // 代价说明：酒馆助手的 getVariables 内部是 klona 深拷贝，且要跨 iframe 序列化；
    // 全局变量表里可能装着其他脚本（MVU 等）的大量数据。v22 及更早每次生图会调用
    // 3-4 次（设置 + 预设 + 插入条目各一次），一次就是一次全表拷贝。
    // 这里做 3 秒 TTL 的内存缓存：同一次生图内只真正读一次；我们自己的写入会立即失效缓存
    const GLOBAL_CACHE_TTL_MS = 3000;
    let globalVarsCache = null;   // { data, at }
    function readGlobalVars(force) {
        const now = Date.now();
        if (!force && globalVarsCache && (now - globalVarsCache.at) < GLOBAL_CACHE_TTL_MS) {
            return globalVarsCache.data;
        }
        const data = getVariables({ type: 'global' }) || {};
        globalVarsCache = { data: data, at: now };
        return data;
    }
    function invalidateGlobalVars() {
        globalVarsCache = null;
    }

    // ─────────────────────────────────────────────────────────────
    // [1] 配置区（含"网页端同步区"——与 nai.sta1n.cn/app.js 强耦合的常量集中在此）
    // 核对方法：curl https://nai.sta1n.cn/app.js 搜 artistPresets / sizeMap，价格公式见
    // 其引用的 generation-pricing.js（权威源：github.com/STA1N156/Nai2API 上游仓库）；
    // GET /api/settings 可看 defaultModel/defaults
    // ─────────────────────────────────────────────────────────────
    const BASE_URL = 'https://nai.sta1n.cn';
    const POLL_INTERVAL_MS = 2000;
    const POLL_TIMEOUT_MS = 180000; // 3 分钟
    const MAX_BATCH = 5;
    // 单次请求超时（含提交/轮询/余额），超时自动 abort 并抛错
    const FETCH_TIMEOUT_MS = 30000;
    // 提示词生成的超时保护：超过后精确停止本次生成请求并抛错，
    // 避免模型/接口卡住时整个生图流程一直挂着
    const AI_GEN_TIMEOUT_MS = 120000;
    // 轮询允许连续失败的次数（网络抖动/服务端 5xx 时重试而非直接判死）
    const POLL_MAX_CONSECUTIVE_ERRORS = 5;

    // ── 网页端同步区：模型 ──
    // 网页端模型下拉框共两项；cost = 标准图（≤28 步且像素 ≤1024×1024）单张点数
    // V5 模型标准价 6 点/张（原 8，站点 2026-10-10 下调）；4.5 为 1 点/张
    // （价格以网页端 generation-pricing.js 的 generationPrice() 为准，2026-10-12 核实）
    const MODEL_OPTIONS = [
        { key: 'nai-diffusion-4-5-full', label: 'NAI 4.5 Full（1点起/张）', cost: 1 },
        { key: 'nai-diffusion-5-full',   label: 'NAI 5 Full（6点起/张）',  cost: 6 },
    ];

    // 画风预设 key 列表（用于设置面板下拉框）
    // 与 nai.sta1n.cn 网页端 artistPresets 同步：
    //   - 删除 animeOld（网页端已废弃）
    //   - 新增 comicDoujin（动漫同人风）、lolita25d（2.5D 唯美风（萝））
    const STYLE_OPTIONS = [
        { key: '',           label: '不使用画风（由 prompt 驱动）' },
        { key: 'fresh',      label: '韩漫小清新风' },
        { key: 'comicDoujin',label: '动漫同人风' },
        { key: '2.5d',       label: '2.5D 唯美风' },
        { key: 'lolita25d',  label: '2.5D 唯美风（萝）' },
        { key: 'doujin',     label: '本子里番风' },
        { key: 'galgame',    label: 'GalGame 风' },
    ];

    // 画风预设对应的 artist 字符串（提交时填入 payload.artist）
    // API 已废弃 style 字段：画风通过完整 artist 字符串驱动，与网页端一致
    // 来源：https://nai.sta1n.cn/app.js 的 artistPresets
    const ARTIST_PRESETS = {
        fresh: 'masterpiece, best quality,[[[artist:dishwasher1910]]], {{yd_(orange_maru)}}, [artist:ciloranko], [artist:sho_(sho_lwlw)], [ningen mame], soft lighting,year 2024',
        comicDoujin: 'masterpiece, best quality, very aesthetic, modern Japanese anime, official anime art, anime key visual, anime screencap, soft cel shading, soft anime coloring, smooth color transitions, natural skin tones, restrained color palette, slightly desaturated, muted colors, soft ambient lighting, gentle contrast, subtle gradients, subtle bloom, detailed anime background',
        '2.5d': '0.9::misaka_12003-gou ::, dino_(dinoartforame), wanke, liduke, year 2025, realistic, 4k, -2::green ::, textless version, The image is highly intricate finished drawn. Only the character\'s face is in anime style, but their body is in realistic style. 1.35::A highly finished photo-style artwork that has lively color, graphic texture, realistic skin surface, and lifelike flesh with little obliques::. 1.63::photorealistic::, 1.63::photo(medium)::, \\n20::best quality, absurdres, very aesthetic, detailed, masterpiece::,, very aesthetic, masterpiece, no text,',
        // v19：照网页端最新版重抄（原文含真实换行，权重分组的分隔更清晰）
        lolita25d: '20::best quality, absurdres, very aesthetic, detailed, masterpiece::, 20::highly finished::, 10::ultra detailed::, 5::masterpiece::, 5::best quality::,\n2.4::kidmo::, 1.2::omone hokoma agm::, 1.1::dino, wanke, liduke::, 0.8::rurudo, mignon, artist:pottsness, artist:toosaka asagi::, 0.7::misaka_12003-gou::, 0.6::artist:chocoan, artist:ciloranko, artist:rhasta, artist:sho_sho_lwlw::, dino_(dinoartforame), agoto, akakura, 0.9::rurudo(Only body shape), mignon(Only body shape) ::\nyear 2025, textless version, {{petite,loli}}, Petite figure, no text, The image is highly intricate finished drawn. Only the character\'s face is in anime style, but their body is in realistic style. 1.35::A highly finished photo-style artwork that has graphic texture, realistic skin surface, and lifelike flesh with little obliques::, smooth line, glossy skin, realistic, 4k,\n1.63::photorealistic::, 1.63::photo(medium)::, 3::simple background::, 2::depth of field::,\n1.5::vivid color, lively color::, desaturated, muted tones, cinematic desaturation, pale aesthetic, silver-toned,\n-2::green::, -1.5::vibrant, colorful, saturated::',
        doujin: '1.4::asanagi::,{{{{{artist:asanagi}}}}},1.2::xiaoluo_xl::,1.3::Artist: misaka_12003-gou::,1.2::Artist:shexyo::,0.7::Artist:b.sa_(bbbs)::,1::Artist:qiandaiyiyu::,1.05::artist:natedecock::,1.05::artist:kunaboto::,0.75::artist:kandata_nijou::,1.05::artist:zer0.zer0 ::,1.05::artist:jasony::,0.75::misaka_12003-gou ::, dino_(dinoartforame), wanke, liduke, year 2025, realistic, 4k, -2::green ::, {textless version, The image is highly intricate finished drawn,write realistically,true to life}, 1.35::A highly finished photo-style artwork that has lively color, graphic texture, realistic skin surface, and lifelike flesh with little obliques::, 1.63::photorealistic::,3::age slider::,1.63::photo(medium)::, 2::best quality, absurdres, very aesthetic, detailed, masterpiece::,-4::Muscle definition, abs::',
        galgame: 'artist:ningen_mame,, noyu_(noyu23386566),, toosaka asagi,, location,\\n20::best quality, absurdres, very aesthetic, detailed, masterpiece::,:,, very aesthetic, masterpiece, no text,',
    };

    // 尺寸：朝向 × 分辨率组合
    // 与 nai.sta1n.cn 网页端 sizeMap 同步（9 档组合像素见 SIZE_PIXELS）
    const ORIENTATION_OPTIONS = ['竖图', '横图', '方图'];
    const RESOLUTION_OPTIONS = ['1K', '2K', '4K'];

    // 提交任务固定步数：站点仅网页端开放 1-50 步，/api/jobs 上限即 28；
    // 价格公式按步数计费，故步数与计价共用此常量
    const JOB_STEPS = 28;

    // 各尺寸像素数（与站点 generation-pricing.js 的 sizeMap 一致）
    const SIZE_PIXELS = {
        '竖图': [832, 1216], '横图': [1216, 832], '方图': [1024, 1024],
        '2K竖图': [1088, 1600], '2K横图': [1600, 1088], '2K方图': [1344, 1344],
        '4K竖图': [1344, 1984], '4K横图': [1984, 1344], '4K方图': [1728, 1728],
    };

    // 单张点数：与站点 generationPrice() 同一公式（服务端按此实扣，客户端提交的 cost 会被忽略）
    //   标准图（步数 ≤28 且像素 ≤1024×1024）：按模型标准价（4.5 = 1、V5 = 6）
    //   其余：官方 Anlas 折算 base = ceil(2.951823174884865e-6·px + 5.753298233447344e-7·px·steps)
    //         4.5 = max(2, base)；V5 = max(2, ceil(base×1.5))（先取整再乘 1.5 再取整）
    // 2026-10-12 核实（28 步）：2K 竖/横 34/51、2K 方 35/53、4K 竖/横 51/77、4K 方 57/86
    function imageCost(size, model) {
        const px = SIZE_PIXELS[size] || SIZE_PIXELS['竖图'];
        const pixels = px[0] * px[1];
        const modelOpt = MODEL_OPTIONS.find(m => m.key === model) || MODEL_OPTIONS[0];
        if (JOB_STEPS <= 28 && pixels <= 1024 * 1024) return modelOpt.cost;
        const base = Math.ceil(2.951823174884865e-6 * pixels + 5.753298233447344e-7 * pixels * JOB_STEPS);
        return Math.max(2, Math.ceil(base * (modelOpt.key === 'nai-diffusion-5-full' ? 1.5 : 1)));
    }

    // 根据 (orientation, resolution, model) 返回 API 接受的 size 字符串及单张 cost
    function resolveSize(orientation, resolution, model) {
        const ori = ORIENTATION_OPTIONS.indexOf(orientation) >= 0 ? orientation : '竖图';
        const res = RESOLUTION_OPTIONS.indexOf(resolution) >= 0 ? resolution : '1K';
        const size = res === '1K' ? ori : `${res}${ori}`;
        return { size, cost: imageCost(size, model) };
    }

    const DEFAULT_NEGATIVE = [
        '{{{{bad anatomy}}}}', '{bad feet}', 'bad hands', '{{{bad proportions}}}',
        '{blurry}', 'cloned face', 'cropped', '{{{deformed}}}', '{{{disfigured}}}',
        'error', '{{{extra arms}}}', '{extra digit}', '{{{extra legs}}}',
        'extra limbs', '{{extra limbs}}', '{fewer digits}', '{{{fused fingers}}}',
        'gross proportions', 'jpeg artifacts', '{{{{long neck}}}}', 'low quality',
        '{malformed limbs}', '{{missing arms}}', '{missing fingers}',
        '{{missing legs}}', 'mutated hands', '{{{mutation}}}', 'normal quality',
        'poorly drawn face', 'poorly drawn hands', 'signature', 'text',
        '{{too many fingers}}', '{{{ugly}}}', 'username', 'watermark', 'worst quality'
    ].join(',');

    const DEFAULT_SETTINGS = {
        apiKey: '',
        model: 'nai-diffusion-4-5-full', // 模型：4.5 full（1点起）或 5 full（6点起）
        style: '',              // 画风预设 key（空 = 不使用预设）
        size: '竖图',           // 朝向：竖图/横图/方图
        resolution: '1K',       // 分辨率：1K/2K/4K
        count: 1,               // 1-5
        presetPrompt: '',       // 用户预置的正面 prompt（拼接在 AI prompt 前）
        userHint: '',           // 用户对 AI 的额外需求（自然语言，优先级最高）
        customNegative: '',     // 自定义负面 prompt，空 = 用默认
        autoDraw: false,        // 自动生图开关
        // 独立 AI 模型配置
        useCustomAI: false,     // 是否使用独立 AI（关闭=跟随酒馆主 API）
        customAIProfile: '',   // 酒馆 Connection Profile 名称（从 /profile-list 读取）
        // 英文自然语言模式：勾选后 AI 输出英文自然语言画面描述，直接作为生图提示词
        // （适配支持自然语言的模型，如 NAI 4.5 / 5）
        // v23 起替代原 useChinesePrompt（中文描述 + /api/prompt/convert 转换）——
        // 该转换接口受上游 API 影响几乎不可用，且标签转换质量不稳定
        useNaturalLanguage: false,
        // 上下文配置
        contextMessageCount: 10,   // 发给 AI 的消息条数（剔除 NAI 生图消息后）
        contextCharLimit: 10000,   // 上下文文本截断长度（字符数）
    };

    // ─────────────────────────────────────────────────────────────
    // [2] 设置管理（双写：localStorage + 酒馆全局变量）
    // ─────────────────────────────────────────────────────────────
    // 设计原因：insertOrAssignVariables 同步返回后，ST 主进程内存同步有延迟，
    // 导致 onMessageReceived 调 getVariables 读到旧值（"勾选后必须刷新才生效"）。
    // localStorage 是浏览器同源全局同步的，所有 iframe 立即可见，无跨进程延迟。
    // 因此用 localStorage 作为"立即生效"层，全局变量保留为"跨设备同步"层。
    const VAR_KEY = 'nai_draw_settings';
    const LOCAL_KEY = 'nai_draw_settings_v15';

    // 迁移旧设置：把 v22 及更早的 useChinesePrompt 映射到 useNaturalLanguage
    // 旧功能（中文描述 → /api/prompt/convert 转标签）已废弃，勾选过的用户按"想要描述式输入"
    // 的意图迁移到英文自然语言模式；用户没显式设置过新字段时才迁移
    function migrateSettings(merged, raw) {
        if (raw && raw.useNaturalLanguage === undefined && raw.useChinesePrompt === true) {
            merged.useNaturalLanguage = true;
            dlog('[NAI] 设置迁移：useChinesePrompt → useNaturalLanguage');
        }
        return merged;
    }

    function loadSettings() {
        // 1. 优先读 localStorage（同步，立即生效，无跨进程同步延迟）
        try {
            const local = localStorage.getItem(LOCAL_KEY);
            if (local) {
                const raw = JSON.parse(local);
                return migrateSettings(Object.assign({}, DEFAULT_SETTINGS, raw), raw);
            }
        } catch (e) { /* localStorage 不可用或解析失败 */ }
        // 2. 回退到全局变量（跨设备同步来源 + 旧版本数据迁移）
        try {
            const stored = readGlobalVars();
            const s = (stored && stored[VAR_KEY]) || {};
            return migrateSettings(Object.assign({}, DEFAULT_SETTINGS, s), s);
        } catch (e) {
            console.warn('[NAI] loadSettings failed:', e);
            return Object.assign({}, DEFAULT_SETTINGS);
        }
    }

    function saveSettings(settings) {
        // 1. 写 localStorage（同步，立即生效，所有同源 iframe 可见）
        try {
            localStorage.setItem(LOCAL_KEY, JSON.stringify(settings));
        } catch (e) { /* localStorage 不可用 */ }
        // 2. 写全局变量（保证跨设备同步）
        try {
            insertOrAssignVariables({ [VAR_KEY]: settings }, { type: 'global' });
            invalidateGlobalVars();
            return true;
        } catch (e) {
            console.error('[NAI] saveSettings failed:', e);
            return false;
        }
    }

    // ─────────────────────────────────────────────────────────────
    // [2.5] 提示词预设管理（酒馆全局变量为主 + localStorage 镜像）
    // ─────────────────────────────────────────────────────────────
    // 一个预设 = "提示词"区三个字段（预置正面提示词 / 对 AI 额外需求 / 负面提示词）
    // 的快照。v21 起主存储改为酒馆全局变量（随酒馆账号跨设备同步），
    // localStorage 保留为镜像（同步读取，用于设置面板秒开）+ v20 旧数据迁移来源。
    // 读取优先级：全局变量 > localStorage（旧版迁移）；两者都写。
    // 注意：getVariables 读全局变量可能有跨进程同步延迟（秒级），面板打开时
    // 先用镜像渲染再异步刷新即可；写入路径双写保证最终一致
    const PRESET_KEY = 'nai_prompt_presets';        // localStorage 镜像 key（沿用 v20，兼容旧数据）
    const PRESET_VAR_KEY = 'nai_prompt_presets';     // 酒馆全局变量 key

    // 过滤脏数据：必须是非空字符串 name 的对象
    function sanitizePresets(arr) {
        if (!Array.isArray(arr)) return [];
        return arr.filter(p => p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim());
    }

    // 同步读取（供面板渲染兜底）：全局变量优先，失败回退 localStorage 镜像
    function loadPromptPresets() {
        try {
            const stored = readGlobalVars();
            const arr = stored && stored[PRESET_VAR_KEY];
            const list = sanitizePresets(arr);
            if (list.length > 0) return list;
            // 全局变量为空：可能尚未迁移，也可能真没有预设——交给 localStorage 判断
        } catch (e) { /* 全局变量读取失败（如环境异常），走镜像 */ }
        try {
            const raw = localStorage.getItem(PRESET_KEY);
            return sanitizePresets(raw ? JSON.parse(raw) : []);
        } catch (e) { /* 镜像解析失败视为无预设 */ }
        return [];
    }

    // 异步读取最新（供面板打开时刷新）：仅读全局变量，读失败时保持同步层结果
    async function refreshPromptPresets() {
        try {
            const stored = readGlobalVars();
            const list = sanitizePresets(stored && stored[PRESET_VAR_KEY]);
            return list;
        } catch (e) {
            return loadPromptPresets();
        }
    }

    // v20 → v21 迁移：localStorage 有数据而全局变量没有时，把本地预设搬到全局
    // 在面板打开时调用一次；迁移成功后保留 localStorage 镜像（不清除）
    async function migratePresetsIfNeeded() {
        try {
            const stored = readGlobalVars();
            const globalList = sanitizePresets(stored && stored[PRESET_VAR_KEY]);
            if (globalList.length > 0) return; // 已有全局数据，无需迁移
            const raw = localStorage.getItem(PRESET_KEY);
            const localList = sanitizePresets(raw ? JSON.parse(raw) : []);
            if (localList.length === 0) return;
            insertOrAssignVariables({ [PRESET_VAR_KEY]: localList }, { type: 'global' });
            invalidateGlobalVars();
            dlog(`[NAI] 预设迁移完成：${localList.length} 条本地预设已写入全局变量`);
        } catch (e) {
            console.warn('[NAI] 预设迁移检查失败（不影响使用）:', e);
        }
    }

    // 双写保存：全局变量（跨设备同步主存储）+ localStorage（同步镜像）
    // 全局变量写失败时返回 false（此时仅镜像更新，跨端会缺）
    function savePromptPresets(list) {
        let ok = false;
        try {
            insertOrAssignVariables({ [PRESET_VAR_KEY]: list }, { type: 'global' });
            invalidateGlobalVars();
            ok = true;
        } catch (e) {
            console.error('[NAI] savePromptPresets 全局变量写入失败:', e);
        }
        try {
            localStorage.setItem(PRESET_KEY, JSON.stringify(list));
        } catch (e) { /* localStorage 不可用（镜像缺失不致命） */ }
        return ok;
    }

    // 按名字查找（重名返回第一个）
    function findPresetByName(list, name) {
        const n = String(name || '').trim();
        return list.find(p => p.name.trim() === n) || null;
    }

    // ─────────────────────────────────────────────────────────────
    // [2.6] 提示词插入条目管理（v23 新增，全局变量为主 + localStorage 镜像）
    // ─────────────────────────────────────────────────────────────
    // 与"提示词预设"的区别：
    //   预设 = 整套面板字段的快照，用于快速填入表单
    //   插入条目 = 注入到"发给生图提示词 AI 的指令"里的固定要求（位置可选最开头/最末尾）
    //     ⚠ 这些条目是给 AI 的指令，**不会**原样进入发给生图模型的标签；
    //       与"对 AI 的额外需求"的区别：额外需求是单条、编号进要求列表；
    //       插入条目是多条、可勾选、可排序，整段注入在指令的最前或最后
    // 结构：{ position: 'front'|'back', items: [{ id, name, content, enabled }] }
    const INJECT_KEY = 'nai_prompt_injects';
    const INJECT_VAR_KEY = 'nai_prompt_injects';
    // 插入位置：注入到"发给生图提示词 AI 的指令"里的位置
    const INJECT_POSITIONS = [
        { key: 'front', label: '最开头（任务预告之前）' },
        { key: 'back',  label: '最末尾（生成要求与示例之后）' },
    ];
    const DEFAULT_INJECTS = { position: 'front', items: [] };

    function sanitizeInjectItems(arr) {
        if (!Array.isArray(arr)) return [];
        return arr
            .filter(it => it && typeof it === 'object' && typeof it.content === 'string' && it.content.trim())
            .map(it => ({
                id: typeof it.id === 'string' && it.id ? it.id : ('inj_' + Math.random().toString(36).slice(2, 10)),
                name: typeof it.name === 'string' && it.name.trim() ? it.name.trim() : '未命名条目',
                content: it.content,
                enabled: it.enabled !== false,   // 缺省视为启用
            }));
    }

    function normalizeInjects(raw) {
        const obj = (raw && typeof raw === 'object') ? raw : {};
        const pos = obj.position === 'back' ? 'back' : 'front';
        return { position: pos, items: sanitizeInjectItems(obj.items) };
    }

    // 同步读取：全局变量优先，回退 localStorage 镜像
    function loadPromptInjects() {
        try {
            const stored = readGlobalVars();
            const raw = stored && stored[INJECT_VAR_KEY];
            const obj = normalizeInjects(raw);
            if (obj.items.length > 0) return obj;
        } catch (e) { /* 全局变量读取失败，走镜像 */ }
        try {
            const local = localStorage.getItem(INJECT_KEY);
            return normalizeInjects(local ? JSON.parse(local) : null);
        } catch (e) { /* 镜像不可用 */ }
        return Object.assign({}, DEFAULT_INJECTS);
    }

    // 双写保存（全局变量 + localStorage 镜像）
    function savePromptInjects(obj) {
        let ok = false;
        try {
            insertOrAssignVariables({ [INJECT_VAR_KEY]: obj }, { type: 'global' });
            invalidateGlobalVars();
            ok = true;
        } catch (e) {
            console.error('[NAI] 插入条目全局变量写入失败:', e);
        }
        try {
            localStorage.setItem(INJECT_KEY, JSON.stringify(obj));
        } catch (e) { /* 镜像不可用不致命 */ }
        return ok;
    }

    // 拼接启用中的插入条目为一段文本（按数组顺序，换行分隔）
    // 用途：注入到发给"生图提示词 AI"的指令里，因此用换行而非逗号——这是给 AI 的文字要求，
    // 不是生图标签（v23 更正：早期实现误将条目拼进了生图提示词）
    function buildInjectText(obj) {
        const o = obj || loadPromptInjects();
        return (o.items || [])
            .filter(it => it.enabled && it.content && it.content.trim())
            .map(it => it.content.trim())
            .join('\n');
    }

    // ─────────────────────────────────────────────────────────────
    // [3] 工具函数
    // ─────────────────────────────────────────────────────────────

    // 获取 ST 上下文（用于 fetch 绕过 CORS、调用 LLM）
    function getCtx() {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            return SillyTavern.getContext();
        }
        return null;
    }

    // 读取酒馆 Connection Profile 列表（用户在 ST 里配置好的 API 预设）
    // 返回字符串数组，失败返回 []
    // 注意：triggerSlash 返回 Promise<string>，必须 await
    async function getProfileList() {
        try {
            const out = await triggerSlash('/profile-list');
            if (!out) return [];
            // /profile-list 返回 JSON 字符串数组，如 ["Profile1","Profile2"]
            let parsed;
            try {
                parsed = typeof out === 'string' ? JSON.parse(out) : out;
            } catch (_) {
                // 部分版本可能返回换行分隔的纯文本
                return String(out).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            }
            if (Array.isArray(parsed)) {
                return parsed.map(x => String(x).trim()).filter(Boolean);
            }
            return [];
        } catch (e) {
            console.warn('[NAI] /profile-list 失败:', e);
            return [];
        }
    }

    // 读取当前激活的 profile 名（用于切换后还原）
    // /profile 不带参数时返回当前 profile 名
    async function getCurrentProfile() {
        try {
            const out = await triggerSlash('/profile');
            return out ? String(out).trim() : '';
        } catch (e) {
            console.warn('[NAI] /profile 读取失败:', e);
            return '';
        }
    }

    // 切换到指定 profile，失败抛错
    async function switchProfile(name) {
        if (!name) throw new Error('profile 名为空');
        await triggerSlash(`/profile ${name}`);
    }

    // 跨域 fetch：优先走 ST 后端代理绕过 CORS
    // 附带单次请求超时（AbortController），防止网络挂起导致整个生图流程卡死
    async function safeFetch(url, options = {}) {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
        const opts = Object.assign({}, options);
        if (controller) {
            // 不覆盖调用方已设置的 signal（当前没有调用方设置）
            opts.signal = controller.signal;
        }
        try {
            const ctx = getCtx();
            if (ctx && typeof ctx.fetch === 'function') {
                return await ctx.fetch(url, opts);
            }
            // 兜底：直接 fetch（可能受 CORS 限制）
            return await fetch(url, opts);
        } catch (e) {
            if (e && e.name === 'AbortError') {
                throw new Error(`请求超时（${FETCH_TIMEOUT_MS / 1000}s）: ${url}`);
            }
            throw e;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    function toast(type, msg) {
        try {
            if (typeof toastr !== 'undefined' && toastr[type]) {
                toastr[type](msg);
                return;
            }
        } catch (_) { /* ignore */ }
        dlog(`[NAI ${type}]`, msg);
    }

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // 鉴权双发：Bearer 头为旧方式（v18 及以前，实测仍有效），
    // x-user-token 为网页端现行方式。两者同发保证任一侧被废弃时脚本不受影响
    function buildHeaders(apiKey) {
        return {
            'Authorization': `Bearer ${apiKey}`,
            'x-user-token': apiKey,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0',
            'Referer': BASE_URL + '/',
            'Accept': 'application/json',
            'Origin': BASE_URL,
        };
    }

    // ─────────────────────────────────────────────────────────────
    // [4] 上下文提取与 Prompt 构建
    // ─────────────────────────────────────────────────────────────
    // 取供 AI 参考的聊天消息
    // 性能：v22 及更早每次都 getChatMessages('0-9999') 读全量再切片——长聊天（上千楼）
    // 时每生一次图就要构造上千个消息对象。v23 改为只读尾部区间：
    //   酒馆助手支持负数深度范围（-1 = 最后一楼，'-N--1' = 最近 N 楼），
    //   这里按"需要的条数 + 余量"读一小段；老版本范围解析异常时回退全量读取
    const CONTEXT_FETCH_MARGIN = 8;   // 余量：留出被剔除的 NAI 生图消息与空消息的位置

    function getContextMessages(wantCount) {
        const want = Math.max(1, wantCount | 0) + CONTEXT_FETCH_MARGIN;
        try {
            const tail = getChatMessages(`-${want}--1`, { role: 'all' });
            const arr = Array.isArray(tail) ? tail : (tail ? [tail] : []);
            if (arr.length > 0) return arr;
            // 尾部范围读不到（老版本不支持负数范围）：回退全量读取
            const all = getChatMessages('0-9999', { role: 'all' });
            return Array.isArray(all) ? all : [];
        } catch (e) {
            console.warn('[NAI] 读取聊天消息失败:', e);
            return [];
        }
    }

    // 剥离思维链内容：<thought>...</thought> / <thinking>...</thinking> / <reasoning>...</reasoning>
    // 用于清理 AI 输出和聊天历史消息里的思维链，避免污染发给 AI 的上下文
    // 性能：先做一次廉价的 '<' 判断，绝大多数消息不含这些标签，直接跳过正则
    const THOUGHT_TAG_RE = /<\/?(thought|thinking|reasoning)>/i;
    function stripThought(text) {
        if (!text) return '';
        const s = String(text);
        if (s.indexOf('<') === -1 || !THOUGHT_TAG_RE.test(s)) return s.trim();
        let cleaned = s.replace(/<(thought|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
        cleaned = cleaned.replace(/<\/?(thought|thinking|reasoning)>/gi, '');
        return cleaned.trim();
    }

    // 把消息数组拼成给 AI 的上下文文本
    // MAX_PER_MESSAGE：单条消息的字符上限，防止某条超长消息（如大段前情提要）独占上下文
    const MAX_PER_MESSAGE = 4000;
    function extractContextText(messages) {
        const blocks = [];
        for (let i = 0; i < messages.length; i++) {
            const m = messages[i];
            if (!m || !m.message) continue;
            // 方案A：只看 name，不看内容（防止 AI 末尾幻觉性 URL 导致整条消息被误判剔除）
            const name = m.name || m.role;
            if (name === 'NAI 生图') continue;
            let text = stripThought(m.message);
            if (!text) continue;                       // 剥离思维链后为空
            if (text.length > MAX_PER_MESSAGE) text = text.slice(0, MAX_PER_MESSAGE) + '…';
            blocks.push(`${name}: ${text}`);
        }
        return blocks.join('\n\n');
    }

    // 判断是否为脚本自己插入的 NAI 生图消息
    // 方案A：只看 name，不看内容
    // 防止 AI 末尾幻觉性生成 ![](https://nai.sta1n.cn/...) 时被误判
    function isNaiImageMessage(m) {
        if (!m) return false;
        return m.name === 'NAI 生图';
    }

    // 生成本次提示词请求的唯一标识（用于精确停止，不误伤用户自己的生成）
    function makeGenerationId() {
        return 'nai_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    // 精确停止指定生成请求（酒馆助手 API；老版本没有该函数时静默跳过）
    // 只用 stopGenerationById 而不是 stopAllGeneration：后者会把用户自己正在写的回复一起停掉
    function stopGenerationSafely(generationId) {
        if (!generationId) return;
        try {
            if (typeof stopGenerationById === 'function') {
                stopGenerationById(generationId);
            }
        } catch (e) { /* 无此 API */ }
    }

    // v31 修复：剔除脚本自己那次提示词请求里的 n 参数
    // 酒馆助手的 generateRaw 按"普通聊天生成"（type='normal'）构造请求，酒馆 AI 回复配置里的
    // "每次生成多个备选回复"（Multi Swipe，参数 n）大于 1 时会跟着带上 n。DeepSeek 等接口只认 n = 1，
    // 直接返回 Bad Request（个别中转站返回 401）；即使接口接受，也会一次生成 n 份、脚本只用第一份，白耗 token。
    // 酒馆每次发请求前会触发 CHAT_COMPLETION_SETTINGS_READY 并把请求体交给监听者，监听里改动直接生效。
    // 只在本次提示词请求期间挂监听，且只处理消息里带"【任务预告】"标记的请求——主聊天的多备选回复不受影响
    const PROMPT_REQUEST_MARKER = '【任务预告】';   // 与 generatePromptByAI 里的 taskAnnounce 同步

    function messageContentText(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            // 多模态消息：content 是 [{type:'text', text}, {type:'image_url', ...}] 形式
            return content.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
        }
        return '';
    }

    function isOwnPromptRequest(data) {
        const msgs = data && Array.isArray(data.messages) ? data.messages : null;
        if (!msgs) return false;
        return msgs.some(m => m && messageContentText(m.content).indexOf(PROMPT_REQUEST_MARKER) !== -1);
    }

    // 挂上监听，返回摘除函数；环境不支持时返回空函数（行为退回 v30）
    function guardMultiSwipeParam() {
        if (typeof eventOn !== 'function') return () => {};
        const evt = (typeof tavern_events !== 'undefined' && tavern_events && tavern_events.CHAT_COMPLETION_SETTINGS_READY)
            || 'chat_completion_settings_ready';
        try {
            const ret = eventOn(evt, (data) => {
                try {
                    if (!data || data.n == null) return;
                    if (!isOwnPromptRequest(data)) return;
                    dlog(`[NAI] 提示词请求带有 n=${data.n}（酒馆"每次生成多个备选回复"），已从本次请求中移除`);
                    delete data.n;
                } catch (e) { /* 处理失败不阻断请求 */ }
            });
            return () => { try { if (ret && typeof ret.stop === 'function') ret.stop(); } catch (e) { /* 忽略 */ } };
        } catch (e) {
            console.warn('[NAI] 注册 n 参数过滤失败（"每次生成多个备选回复"大于 1 时提示词请求可能报错）:', e);
            return () => {};
        }
    }

    // 统一的提示词生成调用
    // v22 修复要点：
    //   1. 优先用酒馆助手全局 generateRaw 并传 should_silence: true——静默生成不会把酒馆的
    //      发送按钮变成停止按钮，也不会与用户自己的生成互相中断（旧版三处调用都没静默，
    //      在"你发消息触发自动生图"的并发场景下会抢生成状态，是停止按钮卡住的来源之一）
    //   2. ordered_prompts 只保留 user_input，语义等同旧的 raw 调用（请求以 user 消息结尾，
    //      不会出现 assistant 结尾的 prefill 请求）
    //   3. 带 generation_id，超时/失败时能精确停止本次请求
    //   v31：请求期间挂 guardMultiSwipeParam，剔除酒馆 Multi Swipe 带进来的 n
    async function runPromptGeneration(sysPrompt) {
        const ctx = getCtx();
        const generationId = makeGenerationId();
        const unguard = guardMultiSwipeParam();
        let pending;
        try {
            if (typeof generateRaw === 'function') {
                pending = generateRaw({
                    user_input: sysPrompt,
                    ordered_prompts: ['user_input'],
                    should_silence: true,
                    generation_id: generationId,
                });
            } else if (ctx && typeof ctx.generateRaw === 'function') {
                // 兜底 1：ST 上下文自带（旧行为，无法静默）
                pending = ctx.generateRaw({ prompt: sysPrompt, instruct: false });
            } else {
                // 兜底 2：斜杠命令
                const escaped = sysPrompt.replace(/"/g, '\\"');
                pending = triggerSlash(`/genraw lock=on instruct=off "${escaped}"`);
            }
        } catch (e) {
            // 同步抛错时 finally 还没进入，这里先摘掉监听
            unguard();
            throw e;
        }

        let timer = null;
        try {
            return await Promise.race([
                Promise.resolve(pending),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        stopGenerationSafely(generationId);
                        reject(new Error(`提示词生成超时（${AI_GEN_TIMEOUT_MS / 1000}s），本次生图已中止`));
                    }, AI_GEN_TIMEOUT_MS);
                }),
            ]);
        } catch (e) {
            // 自己这次请求失败/超时：顺手精确停掉它，避免残留一个僵尸生成状态
            stopGenerationSafely(generationId);
            throw e;
        } finally {
            if (timer) clearTimeout(timer);
            unguard();
        }
    }

    // 让 AI 根据情节生成生图提示词
    // 两种模式：
    //   - 标签模式（默认）：AI 输出英文 Danbooru 标签，逗号分隔
    //   - 自然语言模式（useNaturalLanguage）：AI 输出英文自然语言画面描述，
    //     直接作为生图提示词交给支持自然语言的模型（NAI 4.5 / 5）
    //     v23 起替代原"中文描述 + /api/prompt/convert 转换"方案（该接口已基本不可用）
    async function generatePromptByAI(contextText, settings) {
        const useNL = !!settings.useNaturalLanguage;

        // 先发情节上下文，再发生图指令——避免长上下文导致末尾指令被遗忘
        // 情节开头重申核心格式要求，形成"指令三明治"
        const taskAnnounce = useNL
            ? '【任务预告】请阅读下方情节，最终输出一段英文自然语言画面描述（用于 NovelAI 生图，不要解释、不要分点、不要输出逗号标签列表）。'
            : '【任务预告】请阅读下方情节，最终输出一份英文 Danbooru 标签提示词（只输出逗号分隔的英文标签，不要解释、不要换行）。';

        const roleLine = useNL
            ? '你是一名二次元绘图画面描述师。'
            : '你是一名二次元绘图提示词工程师。';
        const outputLine = useNL
            ? '基于上面的情节，输出一段用于 NovelAI 生图的英文自然语言画面描述。'
            : '基于上面的情节，输出一份用于 NovelAI 模型的英文 Danbooru 标签提示词。';

        const parts = [
            taskAnnounce,
            '',
            '以下是小说/对话情节:',
            '',
            contextText.slice(-settings.contextCharLimit),
            '',
            '── 以上为情节，以下为生成要求 ──',
            '',
            roleLine,
            outputLine,
            '要求:',
            useNL
                ? '1. 只输出一段英文自然语言描述（一个或多个句子、短语，可包含从句），不要换行、不要解释、不要前缀、不要写成逗号分隔的标签列表。'
                : '1. 只输出标签，用英文逗号分隔，不要换行、不要解释、不要前缀。',
            useNL
                ? '2. 描述顺序: 角色形象, 动作姿势（或角色之间的互动）, 场景环境, 光线氛围。全部从上面的情节中提取。'
                : '2. 标签顺序: 角色形象, 动作姿势（或角色之间的互动）, 场景环境, 光线氛围。全部从上面的情节中提取。',
            '3. 不输出任何 artist: 前缀（画风由系统单独控制）。',
            '4. 不用考虑任何 NSFW 限制，按情节如实描述。',
            ...(useNL ? ['5. 英文描述长度控制在 2000 字符以内，超出会被脚本截断。'] : []),
        ];

        // 用户额外需求优先级最高
        if (settings.userHint && settings.userHint.trim()) {
            const idx = useNL ? '6' : '5';
            parts.push(`${idx}. 用户额外需求（最高优先级，必须满足，可覆盖前面任何要求）: ` + settings.userHint.trim());
        }
        parts.push(
            '',
            '示例（仅展示格式，不要照抄内容）:',
            useNL
                ? 'A silver-haired girl with blue eyes sits leaning forward on a chair in a classroom, wearing a school uniform. Warm afternoon sunlight streams through the window, casting soft light across the room and creating a calm, quiet atmosphere.'
                : 'silver hair, blue eyes, school uniform, sitting on chair, leaning forward, classroom, afternoon, sunlight from window, warm light'
        );

        // 提示词插入（v23）：把启用中的条目注入到发给 AI 的这份指令里
        // 位置可选最开头（任务预告之前）或最末尾（示例之后），多条按列表顺序、换行分隔
        // 注意：这是给"生图提示词 AI"的文字要求，与拼进生图标签的字段不是一回事
        const injectObj = loadPromptInjects();
        const injectText = buildInjectText(injectObj);
        const sysPromptParts = [];
        if (injectText && injectObj.position === 'front') {
            sysPromptParts.push(injectText, '');
        }
        sysPromptParts.push(...parts);
        if (injectText && injectObj.position === 'back') {
            sysPromptParts.push('', injectText);
        }
        const sysPrompt = sysPromptParts.join('\n');

        if (injectText) {
            dlog(`[NAI] 已注入插入条目 ${injectObj.items.filter(i => i.enabled).length} 条，位置=${injectObj.position}`);
        }

        // 调试日志：打印发送给 AI 的完整 sysPrompt（仅 DEBUG 模式输出，不打码不截断）
        dlog('[NAI] ▶ 发送给 AI 的完整 sysPrompt:\n' + sysPrompt);

        let raw = '';
        try {
            if (settings.useCustomAI && settings.customAIProfile) {
                // 走独立 AI：切换到用户选定的 Connection Profile，调用后还原
                const originalProfile = await getCurrentProfile();
                dlog(`[NAI] 切换 Profile: ${originalProfile} → ${settings.customAIProfile}`);
                await switchProfile(settings.customAIProfile);
                try {
                    raw = await runPromptGeneration(sysPrompt);
                } finally {
                    // 还原原 profile（即使生图报错也要还原）
                    if (originalProfile && originalProfile !== settings.customAIProfile) {
                        try {
                            await switchProfile(originalProfile);
                            dlog(`[NAI] 已还原 Profile: ${originalProfile}`);
                        } catch (e) {
                            console.warn('[NAI] 还原 Profile 失败:', e);
                        }
                    }
                }
            } else {
                // 跟随主 API
                raw = await runPromptGeneration(sysPrompt);
            }
            // 调试日志：打印 AI 的原始输出
            dlog('[NAI] ◀ AI 原始输出:\n' + (raw || '(空)'));

            // 剥离思维链内容（复用 stripThought）
            const out = stripThought(raw);
            if (out !== (raw || '').trim()) {
                dlog('[NAI] ◀ 剥离思维链后:\n' + out);
            }
            if (!out) throw new Error('AI 返回空 prompt（或仅含思维链内容）');
            return out;
        } catch (e) {
            console.error('[NAI] AI prompt 生成失败:', e);
            toast('error', 'AI 生成 prompt 失败，已中止生图: ' + e.message);
            throw e;
        }
    }

    // 组装最终正面提示词（发给 NAI 的生图标签）
    // 注意：提示词插入条目**不在这里**——那些条目是给"生图提示词 AI"的指令，
    // 注入点在 generatePromptByAI 里（v23 更正）
    function buildPositivePrompt(aiPrompt, settings) {
        const parts = [];
        if (settings.presetPrompt && settings.presetPrompt.trim()) {
            parts.push(settings.presetPrompt.trim());
        }
        if (aiPrompt && aiPrompt.trim()) {
            parts.push(aiPrompt.trim());
        }
        if (parts.length === 0) {
            parts.push('masterpiece, best quality, very aesthetic, no text', '1girl');
        }
        return parts.join(',');
    }

    function buildNegativePrompt(settings) {
        return (settings.customNegative && settings.customNegative.trim())
            ? settings.customNegative.trim()
            : DEFAULT_NEGATIVE;
    }

    // ─────────────────────────────────────────────────────────────
    // [5] Nai2API 调用
    // ─────────────────────────────────────────────────────────────

    async function submitJob(prompt, negative, settings) {
        // 画风：从预设 key 查找完整 artist 字符串
        // API 已废弃 style 字段——画风通过 artist 字符串驱动（与网页端一致）
        // 未匹配 key（含旧版 animeOld）按"不使用画风"处理，传空串
        const styleOpt = STYLE_OPTIONS.find(s => s.key === settings.style);
        const artist = (styleOpt && styleOpt.key && ARTIST_PRESETS[styleOpt.key]) || '';

        // 尺寸：朝向 + 分辨率组合，cost 按站点同款公式（imageCost）计算
        const sizeInfo = resolveSize(settings.size, settings.resolution, settings.model);

        const payload = {
            prompt: prompt,
            token: settings.apiKey,
            artist: artist,
            model: (MODEL_OPTIONS.find(m => m.key === settings.model) || MODEL_OPTIONS[0]).key,
            size: sizeInfo.size,
            steps: JOB_STEPS,
            scale: 6.0,
            cfg: 0,
            sampler: 'k_dpmpp_2m_sde',
            negative: negative,
            nocache: '1',
            noise_schedule: 'karras',
            cost: sizeInfo.cost,
        };

        const resp = await safeFetch(`${BASE_URL}/api/jobs`, {
            method: 'POST',
            headers: buildHeaders(settings.apiKey),
            body: JSON.stringify(payload),
        });
        if (!resp.ok) {
            const txt = await resp.text().catch(() => '');
            throw new Error(`提交任务失败 ${resp.status}: ${txt.slice(0, 200)}`);
        }
        const job = await resp.json();
        const jid = job && (job.id || job.job_id);
        if (!jid) {
            throw new Error('未获取 job_id: ' + JSON.stringify(job).slice(0, 200));
        }
        return { id: jid, raw: job };
    }

    // 把一次轮询结果写进这张图的进度槽（供"再次点击显示进度"读取）
    // 站点 GET /api/jobs/{id} 返回 queuePosition / queuedCount 与
    // generationProgress { percent, step, total, active }（上游 server/index.js 的 publicJob；
    // /api/jobs 提交的任务 source = 'direct'，属于服务端实时推送进度的来源之一）
    function updateJobSlot(slot, j) {
        if (!slot || !j) return;
        const s = j.status || '';
        slot.status = s === 'completed' ? 'done'
            : (s === 'error' || s === 'cancelled') ? 'failed'
            : (s || slot.status);
        const gp = (j.generationProgress && typeof j.generationProgress === 'object') ? j.generationProgress : {};
        slot.queuePosition = Number(j.queuePosition) || 0;
        slot.queuedCount = Number(j.queuedCount) || 0;
        slot.percent = Number(gp.percent) || 0;
        slot.step = Number(gp.step) || 0;
        slot.total = Number(gp.total) || 0;
    }

    // slot：可选，本张图在 drawState.jobs 里的进度槽
    async function pollJob(jobId, apiKey, slot) {
        const headers = buildHeaders(apiKey);
        const start = Date.now();
        let lastStatus = null;
        let consecutiveErrors = 0;
        while (true) {
            if (Date.now() - start > POLL_TIMEOUT_MS) {
                throw new Error('生图超时（180s）');
            }
            // 容错：网络抖动/超时/5xx 视为临时故障，连续失败达上限才判死
            // （网页端 pollJob 对 5xx/网络错误也是重试而非终止）
            let j = null;
            try {
                const resp = await safeFetch(`${BASE_URL}/api/jobs/${jobId}`, {
                    method: 'GET',
                    headers: headers,
                });
                if (!resp.ok) {
                    // 4xx（除 429）是确定性错误，不重试直接抛
                    if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
                        const txt = await resp.text().catch(() => '');
                        throw new Error(`轮询失败 ${resp.status}: ${txt.slice(0, 200)}`);
                    }
                    throw new Error(`临时错误 ${resp.status}`);
                }
                j = await resp.json();
                consecutiveErrors = 0;
            } catch (e) {
                if (/轮询失败/.test(e.message || '')) throw e;
                consecutiveErrors++;
                if (consecutiveErrors >= POLL_MAX_CONSECUTIVE_ERRORS) {
                    throw new Error(`轮询连续失败 ${consecutiveErrors} 次: ${e.message}`);
                }
                console.warn(`[NAI] 轮询临时失败(${consecutiveErrors}/${POLL_MAX_CONSECUTIVE_ERRORS}):`, e.message);
                await sleep(POLL_INTERVAL_MS);
                continue;
            }
            const status = j.status || '';
            updateJobSlot(slot, j);
            // 排队/生成中提示：同一次生图只弹一次（多张并发时不重复刷屏），标志随 drawState 每次生图重置
            if (status !== lastStatus) {
                lastStatus = status;
                if (status === 'queued' && !drawState.queuedShown) {
                    drawState.queuedShown = true;
                    toast('info', `排队中 #${j.queuePosition ?? '?'}（生图期间再点 🎨NAI生图 可查看进度）`);
                } else if (status === 'running' && !drawState.runningShown) {
                    drawState.runningShown = true;
                    toast('info', '生成中…（再点 🎨NAI生图 可查看进度）');
                }
            }
            if (status === 'done' || status === 'completed') {
                const imgRel = j.imageUrl || '';
                if (!imgRel) {
                    throw new Error('任务完成但无 imageUrl: ' + JSON.stringify(j).slice(0, 200));
                }
                const imgUrl = imgRel.startsWith('http') ? imgRel : BASE_URL + imgRel;
                return { url: imgUrl, cost: j.cost, durationMs: j.durationMs };
            }
            if (status === 'failed' || status === 'error' || status === 'cancelled') {
                throw new Error('任务失败: ' + (j.error || status));
            }
            await sleep(POLL_INTERVAL_MS);
        }
    }

    async function getBalance(apiKey) {
        const resp = await safeFetch(`${BASE_URL}/api/me`, {
            method: 'GET',
            headers: buildHeaders(apiKey),
        });
        if (!resp.ok) {
            throw new Error(`查询余额失败 ${resp.status}`);
        }
        const data = await resp.json();
        const bal = Number(data.balance);
        if (!Number.isFinite(bal)) {
            throw new Error('余额响应格式异常: ' + JSON.stringify(data).slice(0, 200));
        }
        return bal;
    }

    // 说明：v23 已移除 convertPromptByNAI（中文描述 → 英文标签的转换调用）
    // 上游 /api/prompt/convert 受 API 侧问题影响几乎不可用，中文模式改为
    // 由 AI 直接输出英文自然语言描述（useNaturalLanguage），不再需要转换步骤。
    // 如需查阅旧实现，见 archive/v22/nai_draw_v22.js

    // 提交前余额预检（v23 新增）
    // 目的：并发多张时若余额不够，会出现"部分提交成功、部分因余额不足失败"的中间状态，
    // 白扣部分额度还拿不到想要的张数。这里在提交前用 /api/me 比一次，不够就直接拦下。
    // 预检本身不扣额度；查询失败（网络/接口异常）不阻断流程，只记日志后放行
    async function precheckBalance(settings, totalCost) {
        try {
            const bal = await getBalance(settings.apiKey);
            if (bal < totalCost) {
                toast('error', `余额不足：本次需 ${totalCost} 点，当前 ${bal} 点。请调低张数/分辨率或更换模型`);
                console.warn(`[NAI] 余额预检未通过: ${bal} < ${totalCost}`);
                return false;
            }
            dlog(`[NAI] 余额预检通过: ${bal} 点 ≥ 需 ${totalCost} 点`);
            return true;
        } catch (e) {
            console.warn('[NAI] 余额预检失败（不阻断提交）:', e);
            return true;
        }
    }

    // 单次生图（提交+轮询）；slot 为本张图的进度槽（可选）
    async function generateOnce(prompt, negative, settings, slot) {
        const job = await submitJob(prompt, negative, settings);
        if (slot) slot.status = 'queued';
        const result = await pollJob(job.id, settings.apiKey, slot);
        if (slot) slot.status = 'done';
        return result;
    }

    // 并发生成 N 张（相同 prompt）
    // v23：改为失败隔离——每张图各自捕获异常，部分成功也返回已生成的图，
    // 不再像 v22 那样用 Promise.all（一张失败即整体 reject，已成功、已扣费的图全部丢弃）
    // 返回 { results: [{url,cost,durationMs}], failures: [{index, error}] }
    async function generateBatch(prompt, negative, settings) {
        const n = Math.max(1, Math.min(MAX_BATCH, settings.count | 0));
        // 每张图一个进度槽，挂到 drawState 上供进度查询
        const slots = [];
        for (let i = 0; i < n; i++) slots.push({ status: 'submitting' });
        drawState.jobs = slots;
        setDrawPhase('jobs');
        const tasks = [];
        for (let i = 0; i < n; i++) {
            tasks.push(
                generateOnce(prompt, negative, settings, slots[i])
                    .then(r => ({ ok: true, index: i, value: r }))
                    .catch(e => { slots[i].status = 'failed'; return { ok: false, index: i, error: e }; })
            );
        }
        const settled = await Promise.all(tasks);
        const results = [];
        const failures = [];
        settled.forEach(s => {
            if (s.ok) results.push(s.value);
            else failures.push({ index: s.index, error: s.error });
        });
        dlog(`[NAI] 批量结果: 成功 ${results.length} 张，失败 ${failures.length} 张`);
        return { results, failures };
    }

    // ─────────────────────────────────────────────────────────────
    // [6] 结果输出
    // ─────────────────────────────────────────────────────────────

    // 图片消息插入聊天时使用的角色（想改回旧行为就把这里改回 'assistant'）
    //   'assistant'：图片作为 AI 发言进入提示词，会成为续写目标——在图片后直接点继续，
    //                请求末尾就是这条消息，Claude 4.5+ 会以"不支持 assistant prefill"拒绝
    //   'system'   ：酒馆助手会把消息的 extra.type 标成 narrator，ST 对 narrator 消息
    //                发送 role: 'system'（openai.js 注释原文 "100% legal way to send a
    //                message as system"）。于是图片不再是 assistant 轮次、不会成为续写目标
    //   观感上两种角色没有区别（已查证）：ST 样式表里没有任何 narrator 规则，而"系统消息
    //   外观"取决于消息的 is_system，酒馆助手是从 is_hidden 取该值（不传即 false），与 role 无关
    const IMAGE_MESSAGE_ROLE = 'system';

    // 图片消息附带提示词（v30）
    // 图片消息设为隐藏（is_hidden → ST 的 is_system = true）：ST 组装请求时整条跳过，
    // 图片地址与折叠的提示词都不会发给主模型（避免多耗 token、NSFW 标签带偏文风）；
    // 顺带让"图片后直接点继续"时请求末尾不再是这条消息。
    // 隐藏消息照常渲染 Markdown（ST messageFormatting："Let hidden messages have markdown"），
    // 所以 <details> 折叠块能正常显示；DOMPurify 默认放行 details/summary/pre/code。
    // 提示词放进 <pre><code>：ST 的下划线斜体扩展会跳过 <code> 内容，
    // dino_(dinoartforame) 这类标签里的下划线不会被吃掉；内容先 escapeHtml 防止被当成标签
    const IMAGE_MESSAGE_HIDDEN = true;

    // 模型短名（去掉 label 里的价格说明）
    function modelShortName(key) {
        const m = MODEL_OPTIONS.find(x => x.key === key) || MODEL_OPTIONS[0];
        return m.label.replace(/（.*?）/g, '').trim();
    }

    // 生成图片消息正文：图片 + 默认收起的提示词折叠块
    // 显示 AI 写的部分 + 预置正面 + 画风名（画风全文很长，只写名字）；
    // 负面为默认时只写"默认"，自定义才显示全文。完整的最终提示词另存 extra.nai_draw
    // 注意：showdown 不把 <details> 当作 HTML 块标签，单独写会被拆进 <p> 里，
    // 所以外层套一个 <div>（块标签，整块原样保留），且整块写在一行、内部不能有空行
    // （已用 ST 同款 showdown 配置实测：<div> 包裹后输出完整，标签下划线不丢）
    function buildImageMessage(url, meta, cost) {
        const img = `![](${url})`;
        if (!meta) return img;
        const lines = [];
        lines.push('正面（AI）：' + (meta.aiPrompt || '（空）'));
        if (meta.presetPrompt) lines.push('预置正面：' + meta.presetPrompt);
        lines.push('画风：' + meta.styleLabel);
        lines.push('负面：' + (meta.customNegative ? meta.negative : '默认'));
        const params = [modelShortName(meta.model), `${meta.resolution} ${meta.orientation}`, `${JOB_STEPS} 步`];
        if (Number.isFinite(Number(cost)) && cost !== '' && cost != null) params.push(`实扣 ${Number(cost)} 点`);
        lines.push('参数：' + params.join(' · '));
        const body = escapeHtml(lines.join('\n').replace(/\r/g, '')).replace(/\n\s*\n/g, '\n');
        return `${img}\n\n<div class="nai-prompt"><details><summary>🎨 提示词</summary><pre><code>${body}</code></pre></details></div>`;
    }

    // 汇总本次生图的提示词与参数（供 buildImageMessage 与 extra.nai_draw 使用）
    function buildDrawMeta(aiPrompt, prompt, negative, settings) {
        const sizeInfo = resolveSize(settings.size, settings.resolution, settings.model);
        const styleOpt = STYLE_OPTIONS.find(s => s.key === settings.style) || STYLE_OPTIONS[0];
        const res = RESOLUTION_OPTIONS.indexOf(settings.resolution) >= 0 ? settings.resolution : '1K';
        const ori = ORIENTATION_OPTIONS.indexOf(settings.size) >= 0 ? settings.size : '竖图';
        return {
            aiPrompt: String(aiPrompt || '').trim(),
            presetPrompt: String(settings.presetPrompt || '').trim(),
            prompt: prompt,
            negative: negative,
            customNegative: !!(settings.customNegative && settings.customNegative.trim()),
            style: styleOpt.key,
            styleLabel: styleOpt.key ? styleOpt.label : '不使用',
            model: (MODEL_OPTIONS.find(m => m.key === settings.model) || MODEL_OPTIONS[0]).key,
            size: sizeInfo.size,
            orientation: ori,
            resolution: res,
            steps: JOB_STEPS,
            naturalLanguage: !!settings.useNaturalLanguage,
        };
    }

    // 图片插入聊天：每张图仍是独立一条消息（保持原有阅读体验），
    // 但改用一次批量 createChatMessages 调用提交全部消息
    // 性能：v22 及更早是"每张一次 createChatMessages + 300ms 间隔"，
    // 5 张图 = 5 次聊天重渲染 + 5 轮事件派发；批量后只重渲染一次
    // meta：本次生图的提示词与参数（buildDrawMeta），用于折叠块与结构化副本
    async function insertImagesToChat(results, meta) {
        if (!results || results.length === 0) return;
        const messages = results.map(r => ({
            role: IMAGE_MESSAGE_ROLE,
            message: buildImageMessage(r.url, meta, r.cost),
            name: 'NAI 生图',
            is_hidden: IMAGE_MESSAGE_HIDDEN,
            // 酒馆助手传了 extra 就会整体覆盖它为 system 角色自动设置的 extra.type，
            // 所以这里必须把 narrator 标记带上；nai_draw 为结构化副本（留给以后的"重画/改词"）
            extra: meta ? {
                type: 'narrator',
                nai_draw: Object.assign({}, meta, { url: r.url, cost: r.cost, createdAt: new Date().toISOString() }),
            } : { type: 'narrator' },
        }));
        try {
            await createChatMessages(messages, { insert_before: 'end', refresh: 'affected' });
        } catch (e) {
            console.error('[NAI] 消息插入失败:', e);
            toast('error', '消息插入失败: ' + e.message);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // [7] 主流程
    // ─────────────────────────────────────────────────────────────

    // 生图锁 + 进度状态（v30）
    // v29 及更早：锁只在自动生图路径里上（onMessageReceived），手动按钮只检查、从不上锁——
    // 连点两次 🎨NAI生图，或手动生图时恰好来了 AI 回复，会并发跑两套流程（重复扣费、重复插图、
    // 两次切换连接预设交叉执行后还原到错误的预设）。v30 起手动与自动共用这把锁，
    // 锁占用时再点按钮不会新开生图，而是弹出当前进度
    // phase：waiting（自动生图开始前的短暂等待）/ prompt（AI 写提示词）/ precheck（余额预检）/
    //        jobs（提交与生成）/ inserting（插入聊天）/ cooldown（自动生图结束后的防循环冷却）
    const AUTO_START_DELAY_MS = 500;    // 自动生图开始前等待（让酒馆先完成消息渲染）
    const AUTO_COOLDOWN_MS = 2000;      // 自动生图结束后延迟释放锁，确保插图触发的事件已过期
    const drawState = {
        active: false,
        isAuto: false,
        phase: 'idle',
        startedAt: 0,
        phaseAt: 0,
        jobs: [],              // 每张图一个进度槽：{ status, queuePosition, queuedCount, percent, step, total }
        queuedShown: false,    // "排队中/生成中"提示去重（同一次生图只弹一次）
        runningShown: false,
    };

    function beginDraw(isAuto) {
        const now = Date.now();
        drawState.active = true;
        drawState.isAuto = !!isAuto;
        drawState.phase = isAuto ? 'waiting' : 'prompt';
        drawState.startedAt = now;
        drawState.phaseAt = now;
        drawState.jobs = [];
        drawState.queuedShown = false;
        drawState.runningShown = false;
    }

    function endDraw() {
        drawState.active = false;
        drawState.phase = 'idle';
        drawState.jobs = [];
    }

    function setDrawPhase(phase) {
        drawState.phase = phase;
        drawState.phaseAt = Date.now();
    }

    // 单张图的状态文字
    function describeSlot(slot) {
        if (!slot) return '准备中';
        switch (slot.status) {
            case 'submitting': return '正在提交';
            case 'queued':
                return slot.queuePosition
                    ? `排队中 #${slot.queuePosition}${slot.queuedCount ? '/' + slot.queuedCount : ''}`
                    : '排队中';
            case 'running':
                // 站点没给百分比（或尚未推送）时退化为"生成中"
                if (slot.percent > 0) {
                    const steps = (slot.step && slot.total) ? `（第 ${slot.step}/${slot.total} 步）` : '';
                    return `生成中 ${Math.round(slot.percent)}%${steps}`;
                }
                return '生成中';
            case 'done': return '已完成';
            case 'failed': return '失败';
            default: return slot.status || '准备中';
        }
    }

    function describeJobs(jobs) {
        const n = jobs.length;
        if (n === 0) return '正在提交任务';
        if (n === 1) return describeSlot(jobs[0]);
        const done = jobs.filter(j => j.status === 'done').length;
        const failed = jobs.filter(j => j.status === 'failed').length;
        const pending = [];
        jobs.forEach((j, i) => {
            if (j.status !== 'done' && j.status !== 'failed') pending.push(`第 ${i + 1} 张${describeSlot(j)}`);
        });
        let s = `已完成 ${done}/${n} 张`;
        if (failed) s += `，失败 ${failed} 张`;
        if (pending.length) s += '；' + pending.join('，');
        return s;
    }

    // 锁占用时再次点击 🎨NAI生图 显示的进度文字
    function formatDrawProgress() {
        const now = Date.now();
        const who = drawState.isAuto ? '自动生图' : '生图';
        const elapsed = `已 ${Math.max(0, Math.round((now - drawState.startedAt) / 1000))} 秒`;
        switch (drawState.phase) {
            case 'waiting': return `${who}即将开始…`;
            case 'prompt': return `${who}进行中：AI 正在写提示词…（${elapsed}）`;
            case 'precheck': return `${who}进行中：正在核对余额…（${elapsed}）`;
            case 'jobs': return `${who}进行中：${describeJobs(drawState.jobs)}（${elapsed}）`;
            case 'inserting': return `${who}进行中：正在把图片插入聊天…（${elapsed}）`;
            case 'cooldown': {
                const left = Math.max(1, Math.ceil((drawState.phaseAt + AUTO_COOLDOWN_MS - now) / 1000));
                return `${who}刚刚结束，${left} 秒后可再次生图`;
            }
            default: return `${who}进行中（${elapsed}）`;
        }
    }

    async function doDraw(settings, isAuto = false) {
        if (!settings.apiKey) {
            toast('error', '请先在 ⚙️ NAI 设置 中填入 API Key');
            return;
        }
        // 手动按钮：锁占用时不新开生图，弹出当前进度；否则自己上锁、结束时释放
        // 自动路径（isAuto=true）由 onMessageReceived 负责上锁与释放（含开始前等待与结束后冷却）
        if (!isAuto) {
            if (drawState.active) {
                toast('info', formatDrawProgress());
                dlog('[NAI] 生图进行中，显示进度：', drawState.phase);
                return;
            }
            beginDraw(false);
        }
        try {
            await runDraw(settings);
        } finally {
            if (!isAuto) endDraw();
        }
    }

    async function runDraw(settings) {
        setDrawPhase('prompt');
        // 只读尾部一小段 → 剔除 NAI 生图消息 → 取最近 N 条真实对话（N 由设置控制）
        const tail = getContextMessages(settings.contextMessageCount);
        const filtered = tail.filter(m => !isNaiImageMessage(m));
        const messages = filtered.slice(-settings.contextMessageCount);
        dlog(`[NAI] 上下文准备: 读取尾部 ${tail.length} 条 → 剔除 NAI 生图后 ${filtered.length} 条 → 取最近 ${settings.contextMessageCount} 条`);
        const contextText = extractContextText(messages);

        try {
            toast('info', 'AI 生成提示词中…');
            let aiPrompt = await generatePromptByAI(contextText, settings);

            // 自然语言模式：AI 已直接输出英文自然语言描述，无需任何转换，直接进生图提示词
            // 仅做长度兜底（sysPrompt 已要求 AI 控制在 2000 字符内，但模型可能不遵守）
            // 注：这里不再单独打印描述内容——自然语言模式下它就是最终 prompt，
            // 下面「发送给生图模型的完整 prompt」一行已完整输出，避免重复刷屏
            if (settings.useNaturalLanguage) {
                const MAX_NL = 2000;
                if (aiPrompt.length > MAX_NL) {
                    dlog(`[NAI] 英文描述 ${aiPrompt.length} 字符超出上限，截断至 ${MAX_NL}`);
                    aiPrompt = aiPrompt.slice(0, MAX_NL);
                }
            }

            const prompt = buildPositivePrompt(aiPrompt, settings);
            const negative = buildNegativePrompt(settings);
            dlog('[NAI] ▶ 发送给生图模型的完整 prompt:\n' + prompt);
            dlog('[NAI] ▶ 发送给生图模型的 negative:\n' + negative);

            // 提交前余额预检（张数 × 单张 cost）
            const count = Math.max(1, Math.min(MAX_BATCH, settings.count | 0));
            const unitCost = resolveSize(settings.size, settings.resolution, settings.model).cost;
            setDrawPhase('precheck');
            if (!(await precheckBalance(settings, unitCost * count))) return;

            toast('info', `提交 ${count} 张生图任务…`);
            const { results, failures } = await generateBatch(prompt, negative, settings);

            // 部分成功也要把已生成的图插进聊天（v23 失败隔离）
            if (results.length > 0) {
                setDrawPhase('inserting');
                await insertImagesToChat(results, buildDrawMeta(aiPrompt, prompt, negative, settings));
            }

            if (failures.length === 0) {
                toast('success', `生成完成，共 ${results.length} 张`);
            } else if (results.length > 0) {
                toast('warning', `部分完成：成功 ${results.length} 张，失败 ${failures.length} 张（${failures[0].error.message}）`);
            } else {
                // 全部失败：走统一错误处理
                throw failures[0].error;
            }
        } catch (e) {
            console.error('[NAI] 生图失败:', e);
            const msg = String(e && e.message || e);
            if (msg.includes('401') || /unauthorized|invalid.*token/i.test(msg)) {
                toast('error', 'API Key 无效，请检查设置');
            } else if (msg.includes('402') || msg.includes('403') || /insufficient|余额不足/i.test(msg)) {
                toast('error', '余额不足或无权限，请点 💰NAI余额 检查（注意：2K/4K 按像素公式计费，单张点数远高于 1K）');
            } else if (/prefill|last message must be user|assistant message/i.test(msg)) {
                // Claude 4.5+ 不再支持以 assistant 结尾的请求（旧版靠 prefill 续写）。
                // 在"AI 回复 → 直接点继续"（回复尚未有后续用户消息）时就会撞这个错
                toast('error', '模型不支持"续写"式请求（末尾是 assistant 消息）。请先发出一条自己的消息再续写；若发送按钮卡在停止状态，按一下停止或刷新页面即可');
            } else {
                toast('error', '生图失败: ' + msg);
            }
        }
    }

    async function doBalance(settings) {
        if (!settings.apiKey) {
            toast('error', '请先在 ⚙️ NAI 设置 中填入 API Key');
            return;
        }
        try {
            const bal = await getBalance(settings.apiKey);
            toast('success', `💰 余额 ${bal} 点`);
        } catch (e) {
            console.error('[NAI] 余额查询失败:', e);
            if (e.message && e.message.includes('401')) {
                toast('error', 'API Key 无效，请检查设置');
            } else {
                toast('error', '查询失败: ' + e.message);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────
    // [8] 设置面板（HTML 弹窗）
    // ─────────────────────────────────────────────────────────────

    // 获取弹窗挂载目标文档。
    // 优先 parent.document（脚本 iframe 通常不可见，body 高度为 0）；
    // 跨域或不可访问时回落到自身 document。
    function getTopDoc() {
        try {
            if (window.parent && window.parent.document && window.parent !== window) {
                return window.parent.document;
            }
        } catch (_) { /* 跨域或不可访问 */ }
        return document;
    }

    // 面板样式表：集中注入一份 <style>，替代原先"每个元素都写内联 style"的写法
    // 瘦身效果：面板标记从约 12KB、83 处内联样式降到约 4KB；浏览器解析也更省
    const PANEL_STYLE_ID = 'nai-draw-style';
    const PANEL_CSS = [
        '.nai-modal{position:absolute;top:0;left:0;right:0;bottom:0;width:100%;min-height:100%;background:rgba(0,0,0,.85);z-index:2147483647;overflow-y:auto;-webkit-overflow-scrolling:touch;font-family:sans-serif;box-sizing:border-box;padding:16px 8px}',
        '.nai-card{background:#1a1a1a;color:#eee;padding:20px 16px;border-radius:8px;box-sizing:border-box;width:100%;max-width:520px;margin:0 auto}',
        '.nai-card h3{margin:0 0 16px;color:#e8c170}',
        '.nai-sec{margin-bottom:12px;border:1px solid #444;border-radius:6px;padding:0 12px 12px;background:#222}',
        '.nai-sec>summary,.nai-sub>summary{cursor:pointer;padding:8px 0;font-weight:bold;list-style:none}',
        '.nai-sec>summary{color:#e8c170}',
        '.nai-sub{border-top:1px dashed #444;margin-top:12px;padding-top:4px}',
        '.nai-sub>summary{color:#aaa;font-size:13px}',
        '.nai-row{display:block;margin-bottom:12px}',
        '.nai-row:last-child{margin-bottom:0}',
        '.nai-lab{margin-bottom:4px}',
        '.nai-in,.nai-sel,.nai-ta{width:100%;padding:6px;background:#2a2a2a;color:#eee;border:1px solid #444;border-radius:4px;box-sizing:border-box}',
        '.nai-hint{margin-top:4px;font-size:12px;color:#888}',
        '.nai-tip{margin-bottom:8px;font-size:12px;color:#888}',
        '.nai-subtitle{margin-bottom:8px;color:#aaa;font-size:13px}',
        '.nai-flex{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}',
        '.nai-cols{display:flex;gap:8px}',
        '.nai-grow{flex:1;min-width:0}',
        '.nai-btn{padding:6px 12px;background:#444;color:#eee;border:none;border-radius:4px;cursor:pointer;white-space:nowrap;flex:0 0 auto}',
        '.nai-btn-ok{background:#3a5a3a}',
        '.nai-btn-no{background:#5a3a3a}',
        '.nai-btn-go{padding:8px 16px;background:#e8c170;color:#000}',
        '.nai-btn-lg{padding:8px 16px}',
        '.nai-sep{margin-bottom:12px;padding-bottom:12px;border-bottom:1px dashed #444}',
        '.nai-actions{display:flex;gap:8px;justify-content:flex-end}',
        '.nai-item{display:flex;align-items:center;gap:6px;margin-bottom:6px}',
        '.nai-chip{flex:1;min-width:0;text-align:left;padding:6px 8px;background:#2a2a2a;color:#eee;border:1px solid #444;border-radius:4px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.nai-ico{flex:0 0 auto;padding:4px 7px;background:#444;color:#eee;border:none;border-radius:4px;cursor:pointer}',
        '.nai-ico-md{padding:6px 8px}',
        '.nai-ico:disabled{opacity:.35}',
        '.nai-ico-no{background:#5a3a3a}',
        '.nai-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}',
        '.nai-off{color:#777}',
        '.nai-cb{flex:0 0 auto;width:18px;height:18px;cursor:pointer}',
    ].join('\n');

    // 注入样式表（同源 iframe 下只注入一次；已存在则跳过）
    function ensurePanelStyles(doc) {
        try {
            if (doc.getElementById(PANEL_STYLE_ID)) return;
            const style = doc.createElement('style');
            style.id = PANEL_STYLE_ID;
            style.textContent = PANEL_CSS;
            (doc.head || doc.body).appendChild(style);
        } catch (e) { /* 注入失败不影响功能，只是样式退化 */ }
    }

    async function openSettingsUI() {
        try {
            let settings = loadSettings();

            const html = `
        <div id="nai-settings-modal" class="nai-modal">
          <div class="nai-card">
            <h3>🎨 Nai2API 设置</h3>

            <details class="nai-sec">
              <summary>▸ 基础</summary>
              <label class="nai-row">
                <div class="nai-lab">API Key</div>
                <input id="nai-apiKey" class="nai-in" type="password" value="${escapeHtml(settings.apiKey)}"/>
              </label>
              <label class="nai-row">
                <div class="nai-lab">模型</div>
                <select id="nai-model" class="nai-sel">
                  ${MODEL_OPTIONS.map(m => `<option value="${m.key}" ${m.key === (settings.model || 'nai-diffusion-4-5-full') ? 'selected' : ''}>${m.label}</option>`).join('')}
                </select>
              </label>
              <label class="nai-row">
                <div class="nai-lab">画风预设</div>
                <select id="nai-style" class="nai-sel">
                  ${STYLE_OPTIONS.map(s => `<option value="${s.key}" ${s.key === settings.style ? 'selected' : ''}>${s.label}</option>`).join('')}
                </select>
              </label>
              <div class="nai-row">
                <div class="nai-lab">尺寸</div>
                <div class="nai-cols">
                  <select id="nai-size" class="nai-sel nai-grow">
                    ${ORIENTATION_OPTIONS.map(s => `<option value="${s}" ${s === settings.size ? 'selected' : ''}>${s}</option>`).join('')}
                  </select>
                  <select id="nai-resolution" class="nai-sel nai-grow">
                    ${RESOLUTION_OPTIONS.map(s => `<option value="${s}" ${s === (settings.resolution || '1K') ? 'selected' : ''}>${s}</option>`).join('')}
                  </select>
                </div>
                <div id="nai-cost-hint" class="nai-hint">1K = 1 点/张（NAI 5 = 6）；2K/4K 按官方 Anlas 公式计费</div>
              </div>
              <label class="nai-row">
                <div class="nai-lab">生成数量 (1-5)</div>
                <input id="nai-count" class="nai-in" type="number" min="1" max="5" value="${settings.count}"/>
              </label>
            </details>

            <details open class="nai-sec">
              <summary>▸ 提示词</summary>
              <label class="nai-row">
                <div class="nai-lab">预置正面提示词（拼在 AI 提示词前）</div>
                <textarea id="nai-preset" class="nai-ta" rows="3">${escapeHtml(settings.presetPrompt)}</textarea>
              </label>
              <label class="nai-row">
                <div class="nai-lab">对 AI 的额外需求（最高优先级）</div>
                <textarea id="nai-userHint" class="nai-ta" rows="3" placeholder="例如：傍晚夕阳逆光、画面偏冷色调、人物带微笑">${escapeHtml(settings.userHint)}</textarea>
              </label>
              <label class="nai-row">
                <div class="nai-lab">自定义负面提示词（空 = 默认）</div>
                <textarea id="nai-negative" class="nai-ta" rows="3">${escapeHtml(settings.customNegative)}</textarea>
              </label>
              <details id="nai-preset-panel" class="nai-sub">
                <summary id="nai-preset-summary">▸ 提示词预设（跨设备同步）</summary>
                <div class="nai-tip">保存/填入上面三个字段</div>
                <div class="nai-flex">
                  <input id="nai-preset-name" class="nai-in nai-grow" type="text" placeholder="预设名称"/>
                  <button id="nai-preset-save" class="nai-btn nai-btn-ok">💾 存为预设</button>
                </div>
                <div id="nai-preset-list"></div>
                <div id="nai-preset-empty" class="nai-tip" style="display:none;">（暂无预设）</div>
              </details>
            </details>

            <details class="nai-sec">
              <summary>▸ 高级</summary>
              <div class="nai-sep">
                <div class="nai-subtitle">上下文配置</div>
                <label class="nai-row">
                  <div class="nai-lab">发送给 AI 的消息条数（取最近 N 条真实对话）</div>
                  <input id="nai-contextMessageCount" class="nai-in" type="number" min="1" max="1000" value="${settings.contextMessageCount}"/>
                </label>
                <label class="nai-row">
                  <div class="nai-lab">上下文截断长度（字符）</div>
                  <input id="nai-contextCharLimit" class="nai-in" type="number" min="1000" max="1000000" step="1000" value="${settings.contextCharLimit}"/>
                </label>
              </div>
              <div class="nai-row">
                <div class="nai-lab">使用独立 AI 模型（关闭 = 跟随酒馆主 API）</div>
                <label><input type="checkbox" id="nai-useCustomAI" ${settings.useCustomAI ? 'checked' : ''}/></label>
              </div>
              <div id="nai-customAI-fields" class="nai-row" style="padding-left:8px;border-left:2px solid #444;${settings.useCustomAI ? '' : 'display:none;'}">
                <div class="nai-lab">酒馆 API 预设（Connection Profile）</div>
                <select id="nai-customAIProfile" class="nai-sel">
                  <option value="">— 请选择 —</option>
                </select>
                <div class="nai-hint">来自酒馆的"连接预设"列表</div>
              </div>
              <div class="nai-row">
                <div class="nai-lab">使用英文自然语言描述（关闭 = 输出标签）</div>
                <label><input type="checkbox" id="nai-useNaturalLanguage" ${settings.useNaturalLanguage ? 'checked' : ''}/></label>
                <div class="nai-hint">勾选后 AI 输出英文自然语言描述（适配 NAI 5），而不是用逗号分隔的单个提示词</div>
              </div>
              <div class="nai-row">
                <div class="nai-lab">自动生图（每条 AI 回复后）</div>
                <label><input type="checkbox" id="nai-autoDraw" ${settings.autoDraw ? 'checked' : ''}/></label>
              </div>
              <details id="nai-inject-panel" class="nai-sub">
                <summary id="nai-inject-summary">▸ 附加提示词条目（附加给生图 tag 的 AI 的内容）</summary>
                <div class="nai-tip">这里的条目会附加给"负责写生图 tag 的那个 AI"，不是生图标签本身。勾选启用，多条按顺序拼接。</div>
                <div class="nai-row">
                  <div class="nai-lab">插入位置</div>
                  <select id="nai-inject-position" class="nai-sel">
                    ${INJECT_POSITIONS.map(p => `<option value="${p.key}">${p.label}</option>`).join('')}
                  </select>
                </div>
                <div class="nai-row">
                  <input id="nai-inject-name" class="nai-in" type="text" placeholder="条目名称" style="margin-bottom:6px;"/>
                  <textarea id="nai-inject-content" class="nai-ta" rows="3" placeholder="给 AI 的要求，如：画面偏电影感，多用逆光与景深" style="margin-bottom:6px;"></textarea>
                  <div class="nai-flex">
                    <button id="nai-inject-add" class="nai-btn nai-btn-ok">＋ 添加条目</button>
                    <button id="nai-inject-cancel-edit" class="nai-btn" style="display:none;">取消编辑</button>
                  </div>
                </div>
                <div id="nai-inject-list"></div>
                <div id="nai-inject-empty" class="nai-tip" style="display:none;">（暂无条目）</div>
              </details>
            </details>

            <div class="nai-actions">
              <button id="nai-cancel" class="nai-btn nai-btn-lg">取消</button>
              <button id="nai-save" class="nai-btn nai-btn-go">保存</button>
            </div>
          </div>
        </div>`;

            const topDoc = getTopDoc();
            ensurePanelStyles(topDoc);
            const old = topDoc.getElementById('nai-settings-modal');
            if (old) old.remove();

            const wrapper = topDoc.createElement('div');
            wrapper.innerHTML = html;
            const modal = wrapper.firstElementChild;
            topDoc.body.appendChild(modal);
            dlog('[NAI] 设置面板已挂载到', topDoc === document ? 'iframe' : 'parent', 'body', modal);

            modal.querySelector('#nai-cancel').onclick = () => modal.remove();

            // v20 → v21：本地预设迁移到全局变量（一次性，异步执行不阻塞面板）
            migratePresetsIfNeeded().then(() => renderPresetList()).catch(() => { /* 迁移失败按现状渲染 */ });

            // 勾选"使用独立 AI"时展开/收起字段
            const useCustomAICheck = modal.querySelector('#nai-useCustomAI');
            const customAIFields = modal.querySelector('#nai-customAI-fields');
            useCustomAICheck.onchange = () => {
                customAIFields.style.display = useCustomAICheck.checked ? '' : 'none';
            };

            // 模型/分辨率变化时动态刷新费用提示（与 resolveSize 同一套规则）
            const modelSelect = modal.querySelector('#nai-model');
            const resolutionSelect = modal.querySelector('#nai-resolution');
            const countInput = modal.querySelector('#nai-count');
            const costHint = modal.querySelector('#nai-cost-hint');
            function refreshCostHint() {
                const sizeInfo = resolveSize(
                    modal.querySelector('#nai-size').value,
                    resolutionSelect.value,
                    modelSelect.value
                );
                const n = Math.max(1, Math.min(MAX_BATCH, parseInt(countInput.value, 10) || 1));
                costHint.textContent = `当前组合：${sizeInfo.cost} 点/张 × ${n} 张 ≈ ${sizeInfo.cost * n} 点`;
            }
            modelSelect.onchange = refreshCostHint;
            resolutionSelect.onchange = refreshCostHint;
            modal.querySelector('#nai-size').onchange = refreshCostHint;
            countInput.oninput = refreshCostHint;
            refreshCostHint();

            // ── 提示词预设交互 ──
            const presetNameInput = modal.querySelector('#nai-preset-name');
            const presetSaveBtn = modal.querySelector('#nai-preset-save');
            const presetListBox = modal.querySelector('#nai-preset-list');
            const presetEmptyHint = modal.querySelector('#nai-preset-empty');
            const presetTextareas = {
                presetPrompt: modal.querySelector('#nai-preset'),
                userHint: modal.querySelector('#nai-userHint'),
                customNegative: modal.querySelector('#nai-negative'),
            };

            // 读取面板当前三个字段的值
            function collectPresetFields() {
                return {
                    presetPrompt: presetTextareas.presetPrompt.value,
                    userHint: presetTextareas.userHint.value,
                    customNegative: presetTextareas.customNegative.value,
                };
            }

            // 把预设内容填回三个字段（直接覆盖，保存设置前不会落库）
            function applyPresetFields(p) {
                presetTextareas.presetPrompt.value = p.presetPrompt || '';
                presetTextareas.userHint.value = p.userHint || '';
                presetTextareas.customNegative.value = p.customNegative || '';
            }

            function renderPresetList(list) {
                if (!list) {
                    // 无参调用：同步读取兜底，随后异步用全局变量最新值刷新一次
                    renderPresetList(loadPromptPresets());
                    refreshPromptPresets().then(latest => {
                        // 与当前同步层一致就不重绘（避免闪烁）
                        if (JSON.stringify(latest) !== JSON.stringify(loadPromptPresets())) {
                            renderPresetList(latest);
                        }
                    }).catch(() => { /* 刷新失败保持现状 */ });
                    return;
                }
                presetListBox.innerHTML = '';
                presetEmptyHint.style.display = list.length === 0 ? '' : 'none';
                list.forEach((p) => {
                    const row = topDoc.createElement('div');
                    row.className = 'nai-item';

                    const nameBtn = topDoc.createElement('button');
                    nameBtn.textContent = p.name;
                    nameBtn.title = '点击填入该预设（覆盖上面三个字段的当前内容）';
                    nameBtn.className = 'nai-chip';
                    nameBtn.onclick = () => {
                        applyPresetFields(p);
                        toast('success', `已填入预设「${p.name}」`);
                    };

                    const renameBtn = topDoc.createElement('button');
                    renameBtn.textContent = '✏️';
                    renameBtn.title = '重命名';
                    renameBtn.className = 'nai-ico nai-ico-md';
                    renameBtn.onclick = async () => {
                        const cur = await refreshPromptPresets();
                        const target = findPresetByName(cur, p.name);
                        if (!target) { renderPresetList(); return; }
                        const newName = prompt('[NAI] 重命名预设:', target.name);
                        if (newName == null) return; // 取消
                        const trimmed = newName.trim();
                        if (!trimmed) { toast('warning', '预设名不能为空'); return; }
                        if (findPresetByName(cur, trimmed) && trimmed !== target.name) {
                            toast('warning', `已存在同名预设「${trimmed}」`);
                            return;
                        }
                        target.name = trimmed;
                        if (savePromptPresets(cur)) {
                            toast('success', '预设已重命名');
                            renderPresetList();
                        }
                    };

                    const delBtn = topDoc.createElement('button');
                    delBtn.textContent = '🗑️';
                    delBtn.title = '删除';
                    delBtn.className = 'nai-ico nai-ico-md nai-ico-no';
                    delBtn.onclick = async () => {
                        if (!confirm(`[NAI] 确定删除预设「${p.name}」？`)) return;
                        const cur = await refreshPromptPresets();
                        const idx = cur.findIndex(x => x.name.trim() === p.name.trim());
                        if (idx >= 0) cur.splice(idx, 1);
                        if (savePromptPresets(cur)) {
                            toast('success', '预设已删除');
                            renderPresetList();
                        }
                    };

                    row.appendChild(nameBtn);
                    row.appendChild(renameBtn);
                    row.appendChild(delBtn);
                    presetListBox.appendChild(row);
                });
            }

            // 折叠箭头方向切换（与外层 summary 的 ▸/▾ 风格一致）
            const presetPanel = modal.querySelector('#nai-preset-panel');
            const presetSummary = modal.querySelector('#nai-preset-summary');
            presetPanel.addEventListener('toggle', () => {
                presetSummary.textContent = (presetPanel.open ? '▾' : '▸') + presetSummary.textContent.replace(/^[▸▾]\s*/, ' ');
            });

            presetSaveBtn.onclick = async () => {
                const name = presetNameInput.value.trim();
                if (!name) { toast('warning', '请先输入预设名称'); return; }
                const fields = collectPresetFields();
                if (!fields.presetPrompt.trim() && !fields.userHint.trim() && !fields.customNegative.trim()) {
                    toast('warning', '三个提示词字段均为空，无需保存预设');
                    return;
                }
                const list = await refreshPromptPresets();
                const existing = findPresetByName(list, name);
                if (existing) {
                    if (!confirm(`[NAI] 已存在同名预设「${name}」，覆盖保存？`)) return;
                    list.splice(list.indexOf(existing), 1);
                }
                list.push({ name: name, ...fields });
                if (savePromptPresets(list)) {
                    presetNameInput.value = '';
                    toast('success', `预设「${name}」已保存（随酒馆账号多端同步）`);
                    renderPresetList();
                } else {
                    toast('error', '预设保存失败（全局变量写入异常，本次仅存本机）');
                }
            };

            renderPresetList();

            // ── 提示词插入条目交互 ──
            const injectPanel = modal.querySelector('#nai-inject-panel');
            const injectSummary = modal.querySelector('#nai-inject-summary');
            const injectPosSelect = modal.querySelector('#nai-inject-position');
            const injectNameInput = modal.querySelector('#nai-inject-name');
            const injectContentInput = modal.querySelector('#nai-inject-content');
            const injectAddBtn = modal.querySelector('#nai-inject-add');
            const injectCancelEditBtn = modal.querySelector('#nai-inject-cancel-edit');
            const injectListBox = modal.querySelector('#nai-inject-list');
            const injectEmptyHint = modal.querySelector('#nai-inject-empty');
            // 正在编辑的条目 id（null = 新增模式）
            let injectEditingId = null;

            // 折叠箭头方向切换
            injectPanel.addEventListener('toggle', () => {
                injectSummary.textContent = (injectPanel.open ? '▾' : '▸') + injectSummary.textContent.replace(/^[▸▾]\s*/, ' ');
            });

            function resetInjectForm() {
                injectEditingId = null;
                injectNameInput.value = '';
                injectContentInput.value = '';
                injectAddBtn.textContent = '＋ 添加条目';
                injectCancelEditBtn.style.display = 'none';
            }

            // 每次改动立即落盘（勾选/排序/增删都即时保存，不依赖面板底部的"保存"）
            function persistInjects(obj) {
                if (savePromptInjects(obj)) return true;
                toast('error', '插入条目保存失败（全局变量写入异常，本次仅存本机）');
                return false;
            }

            function renderInjectList() {
                const state = loadPromptInjects();
                injectPosSelect.value = state.position;
                injectListBox.innerHTML = '';
                injectEmptyHint.style.display = state.items.length === 0 ? '' : 'none';

                state.items.forEach((it, idx) => {
                    const row = topDoc.createElement('div');
                    row.className = 'nai-item';

                    // 勾选框：控制该条目是否参与拼接
                    const cb = topDoc.createElement('input');
                    cb.type = 'checkbox';
                    cb.checked = !!it.enabled;
                    cb.title = '勾选=启用该条目';
                    cb.className = 'nai-cb';
                    cb.onchange = () => {
                        const cur = loadPromptInjects();
                        const target = cur.items.find(x => x.id === it.id);
                        if (!target) return;
                        target.enabled = cb.checked;
                        persistInjects(cur);
                        renderInjectList();
                    };

                    const nameEl = topDoc.createElement('div');
                    nameEl.textContent = it.name + (it.enabled ? '' : '（已停用）');
                    nameEl.title = it.content;
                    nameEl.className = it.enabled ? 'nai-text' : 'nai-text nai-off';

                    // 上移 / 下移：调整多条启用时的拼接顺序
                    const mkMoveBtn = (label, title, delta) => {
                        const b = topDoc.createElement('button');
                        b.textContent = label;
                        b.title = title;
                        b.className = 'nai-ico';
                        b.disabled = (delta < 0 && idx === 0) || (delta > 0 && idx === state.items.length - 1);
                        if (b.disabled) b.style.opacity = '0.35';
                        b.onclick = () => {
                            const cur = loadPromptInjects();
                            const from = cur.items.findIndex(x => x.id === it.id);
                            const to = from + delta;
                            if (from < 0 || to < 0 || to >= cur.items.length) return;
                            const [moved] = cur.items.splice(from, 1);
                            cur.items.splice(to, 0, moved);
                            persistInjects(cur);
                            renderInjectList();
                        };
                        return b;
                    };

                    const editBtn = topDoc.createElement('button');
                    editBtn.textContent = '✏️';
                    editBtn.title = '编辑内容';
                    editBtn.className = 'nai-ico';
                    editBtn.onclick = () => {
                        injectEditingId = it.id;
                        injectNameInput.value = it.name;
                        injectContentInput.value = it.content;
                        injectAddBtn.textContent = '保存修改';
                        injectCancelEditBtn.style.display = '';
                        injectPanel.open = true;
                        injectContentInput.focus();
                    };

                    const delBtn = topDoc.createElement('button');
                    delBtn.textContent = '🗑️';
                    delBtn.title = '删除条目';
                    delBtn.className = 'nai-ico nai-ico-no';
                    delBtn.onclick = () => {
                        if (!confirm(`[NAI] 确定删除插入条目「${it.name}」？`)) return;
                        const cur = loadPromptInjects();
                        cur.items = cur.items.filter(x => x.id !== it.id);
                        persistInjects(cur);
                        if (injectEditingId === it.id) resetInjectForm();
                        renderInjectList();
                    };

                    row.appendChild(cb);
                    row.appendChild(nameEl);
                    row.appendChild(mkMoveBtn('↑', '上移（更靠前）', -1));
                    row.appendChild(mkMoveBtn('↓', '下移（更靠后）', 1));
                    row.appendChild(editBtn);
                    row.appendChild(delBtn);
                    injectListBox.appendChild(row);
                });
            }

            injectPosSelect.onchange = () => {
                const cur = loadPromptInjects();
                cur.position = injectPosSelect.value === 'back' ? 'back' : 'front';
                persistInjects(cur);
                toast('success', cur.position === 'front' ? '插入位置：最开头' : '插入位置：最末尾');
            };

            injectAddBtn.onclick = () => {
                const name = injectNameInput.value.trim();
                const content = injectContentInput.value.trim();
                if (!content) { toast('warning', '请先填写提示词内容'); return; }
                const cur = loadPromptInjects();
                if (injectEditingId) {
                    // 编辑模式：更新原条目
                    const target = cur.items.find(x => x.id === injectEditingId);
                    if (!target) { toast('warning', '该条目已不存在，已切换为新增模式'); resetInjectForm(); return; }
                    target.name = name || target.name;
                    target.content = content;
                } else {
                    if (name && cur.items.some(x => x.name === name)) {
                        toast('warning', `已存在同名条目「${name}」`);
                        return;
                    }
                    cur.items.push({
                        id: 'inj_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                        name: name || ('条目 ' + (cur.items.length + 1)),
                        content: content,
                        enabled: true,
                    });
                }
                if (persistInjects(cur)) {
                    toast('success', injectEditingId ? '条目已更新' : '条目已添加');
                    resetInjectForm();
                    renderInjectList();
                }
            };

            injectCancelEditBtn.onclick = () => resetInjectForm();

            renderInjectList();

            // 填充 Connection Profile 下拉框（来自酒馆 /profile-list）
            try {
                const profileSelect = modal.querySelector('#nai-customAIProfile');
                const profiles = await getProfileList();
                dlog('[NAI] 读取到的 Profile 列表:', profiles);
                // 保留第一个占位 option
                profiles.forEach(name => {
                    const opt = topDoc.createElement('option');
                    opt.value = name;
                    opt.textContent = name;
                    if (name === settings.customAIProfile) opt.selected = true;
                    profileSelect.appendChild(opt);
                });
                if (settings.customAIProfile && profiles.indexOf(settings.customAIProfile) === -1) {
                    // 已保存的 profile 名在当前列表里找不到，追加一条灰色提示
                    const opt = topDoc.createElement('option');
                    opt.value = settings.customAIProfile;
                    opt.textContent = settings.customAIProfile + ' (当前列表中已不存在)';
                    opt.selected = true;
                    opt.style.color = '#a86';
                    profileSelect.appendChild(opt);
                }
                if (profiles.length === 0) {
                    const opt = topDoc.createElement('option');
                    opt.value = '';
                    opt.textContent = '（未读取到任何预设，请先在酒馆里配置）';
                    opt.disabled = true;
                    profileSelect.appendChild(opt);
                }
            } catch (e) {
                console.warn('[NAI] 填充 Profile 下拉框失败:', e);
            }

            modal.querySelector('#nai-save').onclick = () => {
                try {
                    const newSettings = {
                        apiKey: modal.querySelector('#nai-apiKey').value.trim(),
                        model: (MODEL_OPTIONS.find(m => m.key === modal.querySelector('#nai-model').value) || MODEL_OPTIONS[0]).key,
                        style: modal.querySelector('#nai-style').value,
                        size: modal.querySelector('#nai-size').value,
                        resolution: modal.querySelector('#nai-resolution').value,
                        count: Math.max(1, Math.min(5, parseInt(modal.querySelector('#nai-count').value, 10) || 1)),
                        presetPrompt: modal.querySelector('#nai-preset').value,
                        userHint: modal.querySelector('#nai-userHint').value,
                        customNegative: modal.querySelector('#nai-negative').value,
                        autoDraw: modal.querySelector('#nai-autoDraw').checked,
                        contextMessageCount: Math.max(1, Math.min(1000, parseInt(modal.querySelector('#nai-contextMessageCount').value, 10) || 10)),
                        contextCharLimit: Math.max(1000, Math.min(1000000, parseInt(modal.querySelector('#nai-contextCharLimit').value, 10) || 10000)),
                        useCustomAI: modal.querySelector('#nai-useCustomAI').checked,
                        customAIProfile: modal.querySelector('#nai-customAIProfile').value,
                        useNaturalLanguage: modal.querySelector('#nai-useNaturalLanguage').checked,
                    };
                    if (saveSettings(newSettings)) {
                        toast('success', '设置已保存');
                        modal.remove();
                    } else {
                        toast('error', '设置保存失败');
                    }
                } catch (e) {
                    console.error('[NAI] 保存设置失败:', e);
                    alert('[NAI] 保存设置失败: ' + e.message);
                }
            };

            // 检测面板是否可见；不可见则回退到 prompt 流程
            setTimeout(() => {
                try {
                    const r = modal.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0 || !modal.offsetParent) {
                        console.warn('[NAI] 面板不可见，回退到 prompt 流程', r);
                        modal.remove();
                        const k = prompt('[NAI] 当前环境无法显示设置面板（疑似 iframe 限制），请直接输入 API Key：', loadSettings().apiKey || '');
                        if (k != null) {
                            const s = loadSettings();
                            s.apiKey = k.trim();
                            saveSettings(s);
                            toast('success', 'API Key 已保存');
                        }
                    }
                } catch (_) { /* ignore */ }
            }, 100);
        } catch (e) {
            console.error('[NAI] 打开设置面板失败:', e);
            // 兜底：用 prompt() 让用户至少能填 API Key
            try {
                const k = prompt('[NAI] 设置面板打开失败，请直接输入 API Key：', loadSettings().apiKey || '');
                if (k != null) {
                    const s = loadSettings();
                    s.apiKey = k.trim();
                    saveSettings(s);
                    toast('success', 'API Key 已保存（其他设置请后续重试面板）');
                }
            } catch (e2) {
                alert('[NAI] 设置面板与兜底均失败: ' + e2.message);
            }
        }
    }

    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ─────────────────────────────────────────────────────────────
    // [9] 触发入口与初始化
    // ─────────────────────────────────────────────────────────────

    // 自动生图防抖：同一消息 id 不重复触发
    const processedMessageIds = new Set();
    // 生图锁：v30 起与手动按钮共用 drawState.active（见 [7] 主流程），
    // 同时承担"避免插入的消息再次触发生图形成循环"的作用

    async function onMessageReceived(messageId) {
        try {
            const settings = loadSettings();

            // 读取消息内容（用于判断是否为脚本插入的图片消息）
            let m = null;
            try {
                const msgs = getChatMessages(messageId, { role: 'all' });
                m = Array.isArray(msgs) ? msgs[0] : null;
            } catch (e) { /* 读取失败不阻断流程 */ }

            // 方案A：只看 name，不看内容
            // 仅当 name === 'NAI 生图' 才认定为脚本插入的消息
            // 防止 AI 末尾幻觉性生成 ![](https://nai.sta1n.cn/...) 时被误判
            const isNaiImage = !!(m && m.name === 'NAI 生图');

            dlog('[NAI] MSG_RECV id=', messageId,
                'name=', m && m.name,
                'autoDraw=', settings.autoDraw,
                'drawActive=', drawState.active,
                'phase=', drawState.phase,
                'isNaiImage=', isNaiImage);

            if (!settings.autoDraw) return;
            if (messageId == null) return;

            // v22 修复：只在 AI 回复上自动生图
            // 酒馆的 MESSAGE_RECEIVED 对"你自己发的消息"和系统消息同样会触发，旧版只判断了
            // name 与开关，于是你一发消息就会同时跑两条生成：脚本的提示词生成 + 酒馆写正文。
            // 两者会互相抢生成状态（发送按钮变停止按钮、生成被中断），也是触发
            // "assistant 结尾请求被 Claude 4.5+ 拒绝"这类报错的高发窗口。
            // 脚本自己插入的图片消息（role=IMAGE_MESSAGE_ROLE）也会在这里被跳过，无副作用。
            // 角色为空（老版本 getChatMessages 不带 role）时不拦截，保持旧行为
            const msgRole = m && m.role;
            if (msgRole && msgRole !== 'assistant') {
                dlog('[NAI] 跳过非 AI 回复的消息触发 (role=', msgRole, ')');
                return;
            }

            // 防循环 1: 脚本正在生图（手动或自动），期间触发的任何 MESSAGE_RECEIVED 都忽略
            if (drawState.active) {
                dlog('[NAI] 忽略生图过程中的消息触发，避免循环');
                return;
            }

            // 防循环 2: 仅当 name === 'NAI 生图' 才跳过
            // AI 回复永远不会用这个 name，所以不会被误跳过
            if (isNaiImage) {
                dlog('[NAI] 跳过脚本插入的图片消息', messageId);
                return;
            }

            if (processedMessageIds.has(messageId)) return;
            processedMessageIds.add(messageId);
            // 防止 Set 长期膨胀（极端情况下聊天很长且不切换）
            if (processedMessageIds.size > 100) {
                dlog(`[NAI] processedMessageIds 已达 ${processedMessageIds.size} 条，清空防膨胀`);
                processedMessageIds.clear();
                processedMessageIds.add(messageId);
            }

            // 上锁（与手动按钮共用），防止插入消息时再次触发；检查与上锁之间没有 await，不会被抢
            beginDraw(true);
            try {
                await sleep(AUTO_START_DELAY_MS);
                await doDraw(settings, true);
            } finally {
                // 生图结束后延迟释放锁，确保 createChatMessages 触发的 MESSAGE_RECEIVED 已经过期
                setDrawPhase('cooldown');
                await sleep(AUTO_COOLDOWN_MS);
                endDraw();
            }
        } catch (e) {
            console.error('[NAI] 自动生图异常:', e);
        }
    }

    // 重复注册防护
    // 酒馆助手会在脚本关闭/重载时自动卸载监听，但以下两种情况下仍可能残留旧监听：
    //   1) 同一份脚本被粘贴进两个脚本条目并同时启用
    //   2) 极端情况下重载时序异常
    // 一旦重复注册，每条 AI 回复会触发生图 N 次（N 倍 API 调用 + N 倍插入聊天消息），
    // 是能把浏览器拖垮的典型原因。这里用 iframe 内的全局标记做幂等保护：
    // 本次运行会先停掉上一次注册的监听，再注册新的
    const REG_GUARD_KEY = '__nai_draw_registration__';

    function registerTriggers() {
        // 清理上一次运行留下的监听（如果存在）
        try {
            const prev = window[REG_GUARD_KEY];
            if (prev && typeof prev.dispose === 'function') {
                prev.dispose();
                console.warn('[NAI] 检测到上一次注册的监听，已先注销，避免重复触发生图');
            }
        } catch (e) { /* 清理失败不影响后续注册 */ }

        const onReturns = [];
        const track = (ret) => { if (ret && typeof ret.stop === 'function') onReturns.push(ret); };

        window[REG_GUARD_KEY] = {
            dispose: () => {
                onReturns.forEach(r => { try { r.stop(); } catch (e) { /* 忽略 */ } });
                onReturns.length = 0;
            },
            at: Date.now(),
        };

        // 脚本按钮
        try { track(eventOn(getButtonEvent('🎨NAI生图'), () => {
            try { doDraw(loadSettings()); } catch (e) { console.error('[NAI] 生图按钮异常:', e); alert('[NAI] 生图异常: ' + e.message); }
        })); } catch (e) { console.warn('[NAI] 注册生图按钮失败:', e); }
        try { track(eventOn(getButtonEvent('💰NAI余额'), () => {
            try { doBalance(loadSettings()); } catch (e) { console.error('[NAI] 余额按钮异常:', e); alert('[NAI] 余额异常: ' + e.message); }
        })); } catch (e) { console.warn('[NAI] 注册余额按钮失败:', e); }
        try { track(eventOn(getButtonEvent('⚙️NAI设置'), () => {
            try { openSettingsUI(); } catch (e) { console.error('[NAI] 设置按钮异常:', e); alert('[NAI] 设置异常: ' + e.message); }
        })); } catch (e) { console.warn('[NAI] 注册设置按钮失败:', e); }

        // 自动生图监听
        try {
            if (typeof tavern_events === 'undefined' || !tavern_events || !tavern_events.MESSAGE_RECEIVED) {
                console.warn('[NAI] tavern_events.MESSAGE_RECEIVED 不可用，自动生图功能无法启用');
            } else {
                track(eventOn(tavern_events.MESSAGE_RECEIVED, (messageId) => {
                    onMessageReceived(messageId);
                }));
            }
        } catch (e) {
            console.warn('[NAI] 注册 MESSAGE_RECEIVED 失败:', e);
        }

        // 切换聊天时清空已处理消息 id 集合
        // messageId 是当前聊天内的索引，切聊天后会从 0 重新编号，老记录没意义了
        try {
            if (typeof tavern_events === 'undefined' || !tavern_events || !tavern_events.CHAT_CHANGED) {
                console.warn('[NAI] tavern_events.CHAT_CHANGED 不可用，跳过聊天切换清理');
            } else {
                track(eventOn(tavern_events.CHAT_CHANGED, () => {
                    if (processedMessageIds.size > 0) {
                        dlog(`[NAI] 聊天切换，清空 processedMessageIds (${processedMessageIds.size} 条)`);
                        processedMessageIds.clear();
                    }
                }));
            }
        } catch (e) {
            console.warn('[NAI] 注册 CHAT_CHANGED 失败:', e);
        }

        // 这行始终输出（不随 DEBUG 开关），便于确认脚本是否成功加载
        console.info(`[NAI] 脚本已加载 (v31)，调试日志${DEBUG ? '已开启' : '已关闭（排查问题时把脚本开头的 DEBUG 改成 true）'}`);
    }

    // 启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', registerTriggers);
    } else {
        registerTriggers();
    }
})();
