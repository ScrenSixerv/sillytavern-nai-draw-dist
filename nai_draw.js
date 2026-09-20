// Nai2API 酒馆助手生图脚本 v25
// 作者: glm5.2 glm5.3 deepseek-v4.1-flash
// 依赖: JS-Slash-Runner (TavernHelper) + SillyTavern >= 1.12.14   API: https://nai.sta1n.cn
// 功能/入口/部署/调试说明见同目录「脚本头部说明.md」与仓库根目录「部署与使用说明.md」
// 排查问题：把下面的 DEBUG 改为 true

(function () {
    'use strict';

    const DEBUG = false;

    function dlog() {
        if (DEBUG && typeof console !== 'undefined') console.log.apply(console, arguments);
    }

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

    const BASE_URL = 'https://nai.sta1n.cn';
    const POLL_INTERVAL_MS = 2000;
    const POLL_TIMEOUT_MS = 180000; // 3 分钟
    const MAX_BATCH = 5;
    const FETCH_TIMEOUT_MS = 30000;
    const AI_GEN_TIMEOUT_MS = 120000;
    const POLL_MAX_CONSECUTIVE_ERRORS = 5;

    const MODEL_OPTIONS = [
        { key: 'nai-diffusion-4-5-full', label: 'NAI 4.5 Full（1点起/张）', cost: 1 },
        { key: 'nai-diffusion-5-full',   label: 'NAI 5 Full（8点起/张）',  cost: 8 },
    ];

    const STYLE_OPTIONS = [
        { key: '',           label: '不使用画风（由 prompt 驱动）' },
        { key: 'fresh',      label: '韩漫小清新风' },
        { key: 'comicDoujin',label: '动漫同人风' },
        { key: '2.5d',       label: '2.5D 唯美风' },
        { key: 'lolita25d',  label: '2.5D 唯美风（萝）' },
        { key: 'doujin',     label: '本子里番风' },
        { key: 'galgame',    label: 'GalGame 风' },
    ];

    const ARTIST_PRESETS = {
        fresh: 'masterpiece, best quality,[[[artist:dishwasher1910]]], {{yd_(orange_maru)}}, [artist:ciloranko], [artist:sho_(sho_lwlw)], [ningen mame], soft lighting,year 2024',
        comicDoujin: 'masterpiece, best quality, very aesthetic, modern Japanese anime, official anime art, anime key visual, anime screencap, soft cel shading, soft anime coloring, smooth color transitions, natural skin tones, restrained color palette, slightly desaturated, muted colors, soft ambient lighting, gentle contrast, subtle gradients, subtle bloom, detailed anime background',
        '2.5d': '0.9::misaka_12003-gou ::, dino_(dinoartforame), wanke, liduke, year 2025, realistic, 4k, -2::green ::, textless version, The image is highly intricate finished drawn. Only the character\'s face is in anime style, but their body is in realistic style. 1.35::A highly finished photo-style artwork that has lively color, graphic texture, realistic skin surface, and lifelike flesh with little obliques::. 1.63::photorealistic::, 1.63::photo(medium)::, \\n20::best quality, absurdres, very aesthetic, detailed, masterpiece::,, very aesthetic, masterpiece, no text,',
        lolita25d: '20::best quality, absurdres, very aesthetic, detailed, masterpiece::, 20::highly finished::, 10::ultra detailed::, 5::masterpiece::, 5::best quality::,\n2.4::kidmo::, 1.2::omone hokoma agm::, 1.1::dino, wanke, liduke::, 0.8::rurudo, mignon, artist:pottsness, artist:toosaka asagi::, 0.7::misaka_12003-gou::, 0.6::artist:chocoan, artist:ciloranko, artist:rhasta, artist:sho_sho_lwlw::, dino_(dinoartforame), agoto, akakura, 0.9::rurudo(Only body shape), mignon(Only body shape) ::\nyear 2025, textless version, {{petite,loli}}, Petite figure, no text, The image is highly intricate finished drawn. Only the character\'s face is in anime style, but their body is in realistic style. 1.35::A highly finished photo-style artwork that has graphic texture, realistic skin surface, and lifelike flesh with little obliques::, smooth line, glossy skin, realistic, 4k,\n1.63::photorealistic::, 1.63::photo(medium)::, 3::simple background::, 2::depth of field::,\n1.5::vivid color, lively color::, desaturated, muted tones, cinematic desaturation, pale aesthetic, silver-toned,\n-2::green::, -1.5::vibrant, colorful, saturated::',
        doujin: '1.4::asanagi::,{{{{{artist:asanagi}}}}},1.2::xiaoluo_xl::,1.3::Artist: misaka_12003-gou::,1.2::Artist:shexyo::,0.7::Artist:b.sa_(bbbs)::,1::Artist:qiandaiyiyu::,1.05::artist:natedecock::,1.05::artist:kunaboto::,0.75::artist:kandata_nijou::,1.05::artist:zer0.zer0 ::,1.05::artist:jasony::,0.75::misaka_12003-gou ::, dino_(dinoartforame), wanke, liduke, year 2025, realistic, 4k, -2::green ::, {textless version, The image is highly intricate finished drawn,write realistically,true to life}, 1.35::A highly finished photo-style artwork that has lively color, graphic texture, realistic skin surface, and lifelike flesh with little obliques::, 1.63::photorealistic::,3::age slider::,1.63::photo(medium)::, 2::best quality, absurdres, very aesthetic, detailed, masterpiece::,-4::Muscle definition, abs::',
        galgame: 'artist:ningen_mame,, noyu_(noyu23386566),, toosaka asagi,, location,\\n20::best quality, absurdres, very aesthetic, detailed, masterpiece::,:,, very aesthetic, masterpiece, no text,',
    };

    const ORIENTATION_OPTIONS = ['竖图', '横图', '方图'];
    const RESOLUTION_OPTIONS = ['1K', '2K', '4K'];

    function resolveSize(orientation, resolution, model) {
        const ori = ORIENTATION_OPTIONS.indexOf(orientation) >= 0 ? orientation : '竖图';
        let sizeCost = 1;
        if (resolution === '2K') { sizeCost = 15; }
        else if (resolution === '4K') { sizeCost = 25; }
        const modelOpt = MODEL_OPTIONS.find(m => m.key === model);
        const modelCost = modelOpt ? modelOpt.cost : 1;
        const size = resolution === '1K' ? ori : `${resolution}${ori}`;
        return { size, cost: Math.max(sizeCost, modelCost) };
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
        model: 'nai-diffusion-4-5-full', // 模型：4.5 full（1点起）或 5 full（8点起）
        style: '',              // 画风预设 key（空 = 不使用预设）
        size: '竖图',           // 朝向：竖图/横图/方图
        resolution: '1K',       // 分辨率：1K/2K/4K
        count: 1,               // 1-5
        presetPrompt: '',       // 用户预置的正面 prompt（拼接在 AI prompt 前）
        userHint: '',           // 用户对 AI 的额外需求（自然语言，优先级最高）
        customNegative: '',     // 自定义负面 prompt，空 = 用默认
        autoDraw: false,        // 自动生图开关
        useCustomAI: false,     // 是否使用独立 AI（关闭=跟随酒馆主 API）
        customAIProfile: '',   // 酒馆 Connection Profile 名称（从 /profile-list 读取）
        useNaturalLanguage: false,
        contextMessageCount: 10,   // 发给 AI 的消息条数（剔除 NAI 生图消息后）
        contextCharLimit: 10000,   // 上下文文本截断长度（字符数）
    };

    const VAR_KEY = 'nai_draw_settings';
    const LOCAL_KEY = 'nai_draw_settings_v15';

    function migrateSettings(merged, raw) {
        if (raw && raw.useNaturalLanguage === undefined && raw.useChinesePrompt === true) {
            merged.useNaturalLanguage = true;
            dlog('[NAI] 设置迁移：useChinesePrompt → useNaturalLanguage');
        }
        return merged;
    }

    function loadSettings() {
        try {
            const local = localStorage.getItem(LOCAL_KEY);
            if (local) {
                const raw = JSON.parse(local);
                return migrateSettings(Object.assign({}, DEFAULT_SETTINGS, raw), raw);
            }
        } catch (e) { /* localStorage 不可用或解析失败 */ }
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
        try {
            localStorage.setItem(LOCAL_KEY, JSON.stringify(settings));
        } catch (e) { /* localStorage 不可用 */ }
        try {
            insertOrAssignVariables({ [VAR_KEY]: settings }, { type: 'global' });
            invalidateGlobalVars();
            return true;
        } catch (e) {
            console.error('[NAI] saveSettings failed:', e);
            return false;
        }
    }

    const PRESET_KEY = 'nai_prompt_presets';        // localStorage 镜像 key（沿用 v20，兼容旧数据）
    const PRESET_VAR_KEY = 'nai_prompt_presets';     // 酒馆全局变量 key

    function sanitizePresets(arr) {
        if (!Array.isArray(arr)) return [];
        return arr.filter(p => p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim());
    }

    function loadPromptPresets() {
        try {
            const stored = readGlobalVars();
            const arr = stored && stored[PRESET_VAR_KEY];
            const list = sanitizePresets(arr);
            if (list.length > 0) return list;
        } catch (e) { /* 全局变量读取失败（如环境异常），走镜像 */ }
        try {
            const raw = localStorage.getItem(PRESET_KEY);
            return sanitizePresets(raw ? JSON.parse(raw) : []);
        } catch (e) { /* 镜像解析失败视为无预设 */ }
        return [];
    }

    async function refreshPromptPresets() {
        try {
            const stored = readGlobalVars();
            const list = sanitizePresets(stored && stored[PRESET_VAR_KEY]);
            return list;
        } catch (e) {
            return loadPromptPresets();
        }
    }

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

    function findPresetByName(list, name) {
        const n = String(name || '').trim();
        return list.find(p => p.name.trim() === n) || null;
    }

    const INJECT_KEY = 'nai_prompt_injects';
    const INJECT_VAR_KEY = 'nai_prompt_injects';
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

    function buildInjectText(obj) {
        const o = obj || loadPromptInjects();
        return (o.items || [])
            .filter(it => it.enabled && it.content && it.content.trim())
            .map(it => it.content.trim())
            .join('\n');
    }

    function getCtx() {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            return SillyTavern.getContext();
        }
        return null;
    }

    async function getProfileList() {
        try {
            const out = await triggerSlash('/profile-list');
            if (!out) return [];
            let parsed;
            try {
                parsed = typeof out === 'string' ? JSON.parse(out) : out;
            } catch (_) {
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

    async function getCurrentProfile() {
        try {
            const out = await triggerSlash('/profile');
            return out ? String(out).trim() : '';
        } catch (e) {
            console.warn('[NAI] /profile 读取失败:', e);
            return '';
        }
    }

    async function switchProfile(name) {
        if (!name) throw new Error('profile 名为空');
        await triggerSlash(`/profile ${name}`);
    }

    async function safeFetch(url, options = {}) {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
        const opts = Object.assign({}, options);
        if (controller) {
            opts.signal = controller.signal;
        }
        try {
            const ctx = getCtx();
            if (ctx && typeof ctx.fetch === 'function') {
                return await ctx.fetch(url, opts);
            }
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

    const CONTEXT_FETCH_MARGIN = 8;   // 余量：留出被剔除的 NAI 生图消息与空消息的位置

    function getContextMessages(wantCount) {
        const want = Math.max(1, wantCount | 0) + CONTEXT_FETCH_MARGIN;
        try {
            const tail = getChatMessages(`-${want}--1`, { role: 'all' });
            const arr = Array.isArray(tail) ? tail : (tail ? [tail] : []);
            if (arr.length > 0) return arr;
            const all = getChatMessages('0-9999', { role: 'all' });
            return Array.isArray(all) ? all : [];
        } catch (e) {
            console.warn('[NAI] 读取聊天消息失败:', e);
            return [];
        }
    }

    const THOUGHT_TAG_RE = /<\/?(thought|thinking|reasoning)>/i;
    function stripThought(text) {
        if (!text) return '';
        const s = String(text);
        if (s.indexOf('<') === -1 || !THOUGHT_TAG_RE.test(s)) return s.trim();
        let cleaned = s.replace(/<(thought|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
        cleaned = cleaned.replace(/<\/?(thought|thinking|reasoning)>/gi, '');
        return cleaned.trim();
    }

    const MAX_PER_MESSAGE = 4000;
    function extractContextText(messages) {
        const blocks = [];
        for (let i = 0; i < messages.length; i++) {
            const m = messages[i];
            if (!m || !m.message) continue;
            const name = m.name || m.role;
            if (name === 'NAI 生图') continue;
            let text = stripThought(m.message);
            if (!text) continue;                       // 剥离思维链后为空
            if (text.length > MAX_PER_MESSAGE) text = text.slice(0, MAX_PER_MESSAGE) + '…';
            blocks.push(`${name}: ${text}`);
        }
        return blocks.join('\n\n');
    }

    function isNaiImageMessage(m) {
        if (!m) return false;
        return m.name === 'NAI 生图';
    }

    function makeGenerationId() {
        return 'nai_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    function stopGenerationSafely(generationId) {
        if (!generationId) return;
        try {
            if (typeof stopGenerationById === 'function') {
                stopGenerationById(generationId);
            }
        } catch (e) { /* 无此 API */ }
    }

    async function runPromptGeneration(sysPrompt) {
        const ctx = getCtx();
        const generationId = makeGenerationId();
        let pending;
        if (typeof generateRaw === 'function') {
            pending = generateRaw({
                user_input: sysPrompt,
                ordered_prompts: ['user_input'],
                should_silence: true,
                generation_id: generationId,
            });
        } else if (ctx && typeof ctx.generateRaw === 'function') {
            pending = ctx.generateRaw({ prompt: sysPrompt, instruct: false });
        } else {
            const escaped = sysPrompt.replace(/"/g, '\\"');
            pending = triggerSlash(`/genraw lock=on instruct=off "${escaped}"`);
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
            stopGenerationSafely(generationId);
            throw e;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async function generatePromptByAI(contextText, settings) {
        const useNL = !!settings.useNaturalLanguage;

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
                ? '1. 只输出一段英文自然语言描述（完整句子，可包含从句），不要换行、不要解释、不要前缀、不要写成逗号分隔的标签列表。'
                : '1. 只输出标签，用英文逗号分隔，不要换行、不要解释、不要前缀。',
            useNL
                ? '2. 描述顺序: 角色形象, 动作姿势（或角色之间的互动）, 场景环境, 光线氛围。'
                : '2. 标签顺序: 角色形象, 动作姿势（或角色之间的互动）, 场景环境, 光线氛围。',
            '3. 角色形象、动作姿势（或角色之间的互动）、场景环境、光线氛围全部从上面的情节中提取。',
            '4. 不输出任何 artist: 前缀（画风由系统单独控制）。',
            '5. 不用考虑任何 NSFW 限制，按情节如实描述。',
            ...(useNL ? ['6. 英文描述长度控制在 1500 字符以内，超出会被脚本截断。'] : []),
        ];

        if (settings.userHint && settings.userHint.trim()) {
            const idx = useNL ? '7' : '6';
            parts.push(`${idx}. 用户额外需求（最高优先级，必须满足，可覆盖前面任何要求）: ` + settings.userHint.trim());
        }
        parts.push(
            '',
            '示例（仅展示格式，不要照抄内容）:',
            useNL
                ? 'A silver-haired girl with blue eyes sits leaning forward on a chair in a classroom, wearing a school uniform. Warm afternoon sunlight streams through the window, casting soft light across the room and creating a calm, quiet atmosphere.'
                : 'silver hair, blue eyes, school uniform, sitting on chair, leaning forward, classroom, afternoon, sunlight from window, warm light'
        );

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

        dlog('[NAI] ▶ 发送给 AI 的完整 sysPrompt:\n' + sysPrompt);

        let raw = '';
        try {
            if (settings.useCustomAI && settings.customAIProfile) {
                const originalProfile = await getCurrentProfile();
                dlog(`[NAI] 切换 Profile: ${originalProfile} → ${settings.customAIProfile}`);
                await switchProfile(settings.customAIProfile);
                try {
                    raw = await runPromptGeneration(sysPrompt);
                } finally {
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
                raw = await runPromptGeneration(sysPrompt);
            }
            dlog('[NAI] ◀ AI 原始输出:\n' + (raw || '(空)'));

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

    async function submitJob(prompt, negative, settings) {
        const styleOpt = STYLE_OPTIONS.find(s => s.key === settings.style);
        const artist = (styleOpt && styleOpt.key && ARTIST_PRESETS[styleOpt.key]) || '';

        const sizeInfo = resolveSize(settings.size, settings.resolution, settings.model);

        const payload = {
            prompt: prompt,
            token: settings.apiKey,
            artist: artist,
            model: (MODEL_OPTIONS.find(m => m.key === settings.model) || MODEL_OPTIONS[0]).key,
            size: sizeInfo.size,
            steps: 28,
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

    const pollJobState = { queuedShown: false, runningShown: false };

    async function pollJob(jobId, apiKey) {
        const headers = buildHeaders(apiKey);
        const start = Date.now();
        let lastStatus = null;
        let consecutiveErrors = 0;
        while (true) {
            if (Date.now() - start > POLL_TIMEOUT_MS) {
                throw new Error('生图超时（180s）');
            }
            let j = null;
            try {
                const resp = await safeFetch(`${BASE_URL}/api/jobs/${jobId}`, {
                    method: 'GET',
                    headers: headers,
                });
                if (!resp.ok) {
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
            if (status !== lastStatus) {
                lastStatus = status;
                if (status === 'queued' && !pollJobState.queuedShown) {
                    pollJobState.queuedShown = true;
                    toast('info', `排队中 #${j.queuePosition ?? '?'}`);
                } else if (status === 'running' && !pollJobState.runningShown) {
                    pollJobState.runningShown = true;
                    toast('info', '生成中…');
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

    async function generateOnce(prompt, negative, settings) {
        const job = await submitJob(prompt, negative, settings);
        const result = await pollJob(job.id, settings.apiKey);
        return result;
    }

    async function generateBatch(prompt, negative, settings) {
        const n = Math.max(1, Math.min(MAX_BATCH, settings.count | 0));
        const tasks = [];
        for (let i = 0; i < n; i++) {
            tasks.push(
                generateOnce(prompt, negative, settings)
                    .then(r => ({ ok: true, index: i, value: r }))
                    .catch(e => ({ ok: false, index: i, error: e }))
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

    const IMAGE_MESSAGE_ROLE = 'system';

    async function insertImagesToChat(results) {
        if (!results || results.length === 0) return;
        const messages = results.map(r => ({
            role: IMAGE_MESSAGE_ROLE,
            message: `![](${r.url})`,
            name: 'NAI 生图',
        }));
        try {
            await createChatMessages(messages, { insert_before: 'end', refresh: 'affected' });
        } catch (e) {
            console.error('[NAI] 消息插入失败:', e);
            toast('error', '消息插入失败: ' + e.message);
        }
    }

    async function doDraw(settings, isAuto = false) {
        if (!settings.apiKey) {
            toast('error', '请先在 ⚙️ NAI 设置 中填入 API Key');
            return;
        }
        if (!isAuto && drawingInProgress) {
            toast('warning', '生图进行中，请稍候再试');
            dlog('[NAI] doDraw 被锁拒绝 (drawingInProgress=true)');
            return;
        }
        pollJobState.queuedShown = false;
        pollJobState.runningShown = false;
        const tail = getContextMessages(settings.contextMessageCount);
        const filtered = tail.filter(m => !isNaiImageMessage(m));
        const messages = filtered.slice(-settings.contextMessageCount);
        dlog(`[NAI] 上下文准备: 读取尾部 ${tail.length} 条 → 剔除 NAI 生图后 ${filtered.length} 条 → 取最近 ${settings.contextMessageCount} 条`);
        const contextText = extractContextText(messages);

        try {
            toast('info', 'AI 生成提示词中…');
            let aiPrompt = await generatePromptByAI(contextText, settings);

            if (settings.useNaturalLanguage) {
                const MAX_NL = 1500;
                if (aiPrompt.length > MAX_NL) {
                    dlog(`[NAI] 英文描述 ${aiPrompt.length} 字符超出上限，截断至 ${MAX_NL}`);
                    aiPrompt = aiPrompt.slice(0, MAX_NL);
                }
            }

            const prompt = buildPositivePrompt(aiPrompt, settings);
            const negative = buildNegativePrompt(settings);
            dlog('[NAI] ▶ 发送给生图模型的完整 prompt:\n' + prompt);
            dlog('[NAI] ▶ 发送给生图模型的 negative:\n' + negative);

            const count = Math.max(1, Math.min(MAX_BATCH, settings.count | 0));
            const unitCost = resolveSize(settings.size, settings.resolution, settings.model).cost;
            if (!(await precheckBalance(settings, unitCost * count))) return;

            toast('info', `提交 ${count} 张生图任务…`);
            const { results, failures } = await generateBatch(prompt, negative, settings);

            if (results.length > 0) {
                await insertImagesToChat(results);
            }

            if (failures.length === 0) {
                toast('success', `生成完成，共 ${results.length} 张`);
            } else if (results.length > 0) {
                toast('warning', `部分完成：成功 ${results.length} 张，失败 ${failures.length} 张（${failures[0].error.message}）`);
            } else {
                throw failures[0].error;
            }
        } catch (e) {
            console.error('[NAI] 生图失败:', e);
            const msg = String(e && e.message || e);
            if (msg.includes('401') || /unauthorized|invalid.*token/i.test(msg)) {
                toast('error', 'API Key 无效，请检查设置');
            } else if (msg.includes('402') || msg.includes('403') || /insufficient|余额不足/i.test(msg)) {
                toast('error', '余额不足或无权限，请点 💰NAI余额 检查（注意 NAI 5 模型 1K 图为 8 点/张）');
            } else if (/prefill|last message must be user|assistant message/i.test(msg)) {
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

    function getTopDoc() {
        try {
            if (window.parent && window.parent.document && window.parent !== window) {
                return window.parent.document;
            }
        } catch (_) { /* 跨域或不可访问 */ }
        return document;
    }

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
                <div id="nai-cost-hint" class="nai-hint">1K = 1 点/张，2K = 15，4K = 25（NAI 5 的 1K 为 8 点）</div>
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

            migratePresetsIfNeeded().then(() => renderPresetList()).catch(() => { /* 迁移失败按现状渲染 */ });

            const useCustomAICheck = modal.querySelector('#nai-useCustomAI');
            const customAIFields = modal.querySelector('#nai-customAI-fields');
            useCustomAICheck.onchange = () => {
                customAIFields.style.display = useCustomAICheck.checked ? '' : 'none';
            };

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

            const presetNameInput = modal.querySelector('#nai-preset-name');
            const presetSaveBtn = modal.querySelector('#nai-preset-save');
            const presetListBox = modal.querySelector('#nai-preset-list');
            const presetEmptyHint = modal.querySelector('#nai-preset-empty');
            const presetTextareas = {
                presetPrompt: modal.querySelector('#nai-preset'),
                userHint: modal.querySelector('#nai-userHint'),
                customNegative: modal.querySelector('#nai-negative'),
            };

            function collectPresetFields() {
                return {
                    presetPrompt: presetTextareas.presetPrompt.value,
                    userHint: presetTextareas.userHint.value,
                    customNegative: presetTextareas.customNegative.value,
                };
            }

            function applyPresetFields(p) {
                presetTextareas.presetPrompt.value = p.presetPrompt || '';
                presetTextareas.userHint.value = p.userHint || '';
                presetTextareas.customNegative.value = p.customNegative || '';
            }

            function renderPresetList(list) {
                if (!list) {
                    renderPresetList(loadPromptPresets());
                    refreshPromptPresets().then(latest => {
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

            const injectPanel = modal.querySelector('#nai-inject-panel');
            const injectSummary = modal.querySelector('#nai-inject-summary');
            const injectPosSelect = modal.querySelector('#nai-inject-position');
            const injectNameInput = modal.querySelector('#nai-inject-name');
            const injectContentInput = modal.querySelector('#nai-inject-content');
            const injectAddBtn = modal.querySelector('#nai-inject-add');
            const injectCancelEditBtn = modal.querySelector('#nai-inject-cancel-edit');
            const injectListBox = modal.querySelector('#nai-inject-list');
            const injectEmptyHint = modal.querySelector('#nai-inject-empty');
            let injectEditingId = null;

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

            try {
                const profileSelect = modal.querySelector('#nai-customAIProfile');
                const profiles = await getProfileList();
                dlog('[NAI] 读取到的 Profile 列表:', profiles);
                profiles.forEach(name => {
                    const opt = topDoc.createElement('option');
                    opt.value = name;
                    opt.textContent = name;
                    if (name === settings.customAIProfile) opt.selected = true;
                    profileSelect.appendChild(opt);
                });
                if (settings.customAIProfile && profiles.indexOf(settings.customAIProfile) === -1) {
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

    const processedMessageIds = new Set();
    let drawingInProgress = false;

    async function onMessageReceived(messageId) {
        try {
            const settings = loadSettings();

            let m = null;
            try {
                const msgs = getChatMessages(messageId, { role: 'all' });
                m = Array.isArray(msgs) ? msgs[0] : null;
            } catch (e) { /* 读取失败不阻断流程 */ }

            const isNaiImage = !!(m && m.name === 'NAI 生图');

            dlog('[NAI] MSG_RECV id=', messageId,
                'name=', m && m.name,
                'autoDraw=', settings.autoDraw,
                'drawingInProgress=', drawingInProgress,
                'isNaiImage=', isNaiImage);

            if (!settings.autoDraw) return;
            if (messageId == null) return;

            const msgRole = m && m.role;
            if (msgRole && msgRole !== 'assistant') {
                dlog('[NAI] 跳过非 AI 回复的消息触发 (role=', msgRole, ')');
                return;
            }

            if (drawingInProgress) {
                dlog('[NAI] 忽略生图过程中的消息触发，避免循环');
                return;
            }

            if (isNaiImage) {
                dlog('[NAI] 跳过脚本插入的图片消息', messageId);
                return;
            }

            if (processedMessageIds.has(messageId)) return;
            processedMessageIds.add(messageId);
            if (processedMessageIds.size > 100) {
                dlog(`[NAI] processedMessageIds 已达 ${processedMessageIds.size} 条，清空防膨胀`);
                processedMessageIds.clear();
                processedMessageIds.add(messageId);
            }

            drawingInProgress = true;
            try {
                await sleep(500);
                await doDraw(settings, true);
            } finally {
                await sleep(2000);
                drawingInProgress = false;
            }
        } catch (e) {
            console.error('[NAI] 自动生图异常:', e);
        }
    }

    const REG_GUARD_KEY = '__nai_draw_registration__';

    function registerTriggers() {
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

        try { track(eventOn(getButtonEvent('🎨NAI生图'), () => {
            try { doDraw(loadSettings()); } catch (e) { console.error('[NAI] 生图按钮异常:', e); alert('[NAI] 生图异常: ' + e.message); }
        })); } catch (e) { console.warn('[NAI] 注册生图按钮失败:', e); }
        try { track(eventOn(getButtonEvent('💰NAI余额'), () => {
            try { doBalance(loadSettings()); } catch (e) { console.error('[NAI] 余额按钮异常:', e); alert('[NAI] 余额异常: ' + e.message); }
        })); } catch (e) { console.warn('[NAI] 注册余额按钮失败:', e); }
        try { track(eventOn(getButtonEvent('⚙️NAI设置'), () => {
            try { openSettingsUI(); } catch (e) { console.error('[NAI] 设置按钮异常:', e); alert('[NAI] 设置异常: ' + e.message); }
        })); } catch (e) { console.warn('[NAI] 注册设置按钮失败:', e); }

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

        console.info(`[NAI] 脚本已加载 (v25)，调试日志${DEBUG ? '已开启' : '已关闭（排查问题时把脚本开头的 DEBUG 改成 true）'}`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', registerTriggers);
    } else {
        registerTriggers();
    }
})();
