'use strict';

(() => {
    const FACTION_INFO = {
        '强盛集团': { req: 3, shape: 'polygon(50% 0%,0% 100%,100% 100%)', color: '#e53935', text: '强', desc: '摸1张牌，额外出1张牌；这张追加牌不可被吃碰。' },
        '三小只': { req: 3, shape: 'polygon(50% 0%,0% 100%,100% 100%)', color: '#e91e63', text: '三', desc: '所有玩家各随机传1张手牌给下家。' },
        '酥酥软软': { req: 3, shape: 'polygon(0% 0%,100% 0%,50% 100%)', color: '#03a9f4', text: '酥', desc: '触发酥酥软软主题特效。' },
        '增重计划': { req: 4, shape: 'polygon(50% 0%,100% 50%,50% 100%,0% 50%)', color: '#ff9800', text: '增', desc: '下家下个行动回合额外摸1张；禁止摸牌时两项效果同时消耗。' },
        '启动·英雄联盟': { req: 5, shape: 'polygon(50% 0%,100% 38%,82% 100%,18% 100%,0% 38%)', color: '#2196f3', text: '英', desc: '随机发动强盛集团、三小只、酥酥软软、增重计划或卷王二人组。' },
        '启动·王者荣耀': { req: 5, shape: 'polygon(50% 0%,100% 38%,82% 100%,18% 100%,0% 38%)', color: '#ffc107', text: '王', desc: '以自己为发动者，复制上一次成功记录的羁绊效果。' },
        '梦之队·一队': { req: 5, shape: 'polygon(50% 0%,100% 38%,82% 100%,18% 100%,0% 38%)', color: '#9c27b0', text: '梦', desc: '组合完成后，手牌多于下家时，赠予下家1张手牌。' },
        '梦之队·二队': { req: 5, shape: 'polygon(50% 0%,100% 38%,82% 100%,18% 100%,0% 38%)', color: '#00bcd4', text: '梦', desc: '组合完成后，手牌少于下家时，赠予下家1张手牌。' },
        '卷王二人组': { req: 2, shape: 'circle(50% at 50% 50%)', color: '#4caf50', text: '卷', desc: '摸1张牌，直接结束本回合。' },
        '南模天团': { req: 4, shape: 'polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)', color: '#673ab7', text: '南', desc: '全场封印吃碰4个行动回合，包含发动回合；额外回合也计数。' }
    };
    const RELATION_MAP = {
        '曾灏铭-刘嘉祺': '【最熟悉的陌生人】复制上一次成功记录的羁绊效果。',
        '曾灏铭-徐翱': '双人关系组合，完成后正常出牌，无额外技能。',
        '徐翱-安以文': '【半段】组成羁绊后手牌至少5张，额外连打1张。',
        '徐翱-李奕潼': '【数学王者】组成羁绊后，双方手牌数量均为质数，双方各获得1次额外出牌；出牌方在下次行动时使用。',
        '朱喆宇-孙佳煜': '【完美镜头】下家暂停1个回合。',
        '刘子豪-安以文': '【妈妈】全场各摸1张牌。',
        '顾嘉誉-郑昕玮': '【坐骑形态】自己下个回合不摸牌。',
        '杨嘉毅-郑昕玮': '【坐骑形态】自己下个回合不摸牌。',
        '单冯烨-刘嘉祺': '【姐姐】自己与下家各随机拿出1张手牌交换。',
        '张浩泉-张浩泉': '【超导战士】额外摸3张并连打3张，之后暂停2个回合。',
        '曾灏铭-曾灏铭': '【孤独的二次元】组成羁绊并摸1张牌。',
        '界曾灏铭-界曾灏铭': '【孤独的二次元】组成羁绊并摸1张牌。',
        '徐翱的针织帽-徐翱': '【助眠神器】可组成双人羁绊。合体打出的针织帽与徐翱按1张参与吃碰，吃碰者暂停1个回合。'
    };
    const CARD_DB = {
        '曾灏铭': { image: 'zhm', factions: ['强盛集团', '增重计划', '启动·王者荣耀', '启动·英雄联盟'], relations: ['刘嘉祺', '徐翱', '曾灏铭'] },
        '徐翱': { image: 'xa', factions: ['强盛集团', '梦之队·二队', '启动·王者荣耀', '启动·英雄联盟', '酥酥软软'], relations: ['安以文', '曾灏铭', '李奕潼', '徐翱的针织帽'] },
        '安以文': { image: 'ayw', factions: ['三小只'], relations: ['徐翱', '刘子豪'] },
        '刘嘉祺': { image: 'ljq', factions: ['三小只'], relations: ['单冯烨', '曾灏铭'] },
        '李奕潼': { image: 'lyt', factions: ['强盛集团', '梦之队·二队', '启动·王者荣耀'], relations: ['徐翱'] },
        '朱喆宇': { image: 'zzy', factions: ['酥酥软软', '强盛集团', '梦之队·一队', '启动·英雄联盟'], relations: ['孙佳煜'] },
        '刘子豪': { image: 'lzh', factions: ['酥酥软软', '强盛集团', '启动·英雄联盟'], relations: ['安以文'] },
        '侯俊贤': { image: 'hjx', factions: ['酥酥软软', '强盛集团', '启动·英雄联盟', '梦之队·一队'], relations: [] },
        '顾嘉誉': { image: 'gjy', factions: ['酥酥软软', '梦之队·一队'], relations: ['郑昕玮'] },
        '杨嘉毅': { image: 'yjy', factions: ['卷王二人组'], relations: ['郑昕玮'] },
        '郑昕玮': { image: 'zxw', factions: ['酥酥软软', '梦之队·一队'], relations: ['杨嘉毅', '顾嘉誉'] },
        '单冯烨': { image: 'sfy', factions: ['酥酥软软', '梦之队·二队', '启动·王者荣耀'], relations: ['刘嘉祺'] },
        '孙佳煜': { image: 'sjy', factions: ['三小只'], relations: ['朱喆宇'] },
        '戴宇豪': { image: 'dyh', factions: ['增重计划', '梦之队·二队'], relations: [] },
        '张浩泉': { image: 'zhq', factions: ['增重计划', '卷王二人组', '酥酥软软'], relations: ['张浩泉'] },
        '顾忻乐': { image: 'gxl', factions: ['增重计划', '启动·王者荣耀'], relations: [] },
        '沈鑫浩': { image: 'sxh', factions: ['梦之队·一队'], relations: [], onPlayDesc: '【独行胜者】手牌仅剩1张沈鑫浩时直接获胜。' },
        '彭籽稼': { image: 'pzj', factions: ['梦之队·二队'], relations: [] },
        '屠明修': { image: 'tmx', factions: ['酥酥软软', '强盛集团', '启动·英雄联盟', '启动·王者荣耀'], relations: [] },
        '刘鸿铭': { image: 'lhm', factions: [], relations: [], isWildcard: true, onPlayDesc: '【侍奉之心】从下家起全员追加1个摸1打1的回合；追加回合不可吃碰，登场技能失效。' },
        '周晓培': { image: 'zxp', factions: [], relations: [], isWildcard: true, onPlayDesc: '【圣诞天使】从下家起全员追加1个摸1打1的回合；追加回合不可吃碰，登场技能失效。' },
        '界刘嘉祺': { image: 'jljq', factions: ['三小只'], relations: [], onPlayDesc: '【哑婆婆】仅向自己展示下家当前全部手牌。' },
        '界曾灏铭': { image: 'jzhm', factions: ['增重计划', '启动·王者荣耀'], relations: ['界曾灏铭'], onPlayDesc: '【铁窗泪】自己与下家各暂停1个回合。' },
        '界彭籽稼': { image: 'jpzj', factions: ['酥酥软软', '梦之队·二队'], relations: [], onPlayDesc: '【讲文明树新风】获得抵挡1次控制的护盾。' },
        '范文豪': { image: 'fwh', factions: ['南模天团'], relations: [], onPlayDesc: '【骗人题】吃碰此牌者暂停1个回合。' },
        '王齐岳': { image: 'wqy', factions: ['强盛集团'], relations: [], onPlayDesc: '【篮球健将】从下家手中随机抢夺1张牌。' },
        '温秦富': { image: 'wqf', factions: ['南模天团'], relations: [], onPlayDesc: '【停止哥】吃碰此牌者暂停1个回合。' },
        '夏运': { image: 'xy', factions: ['南模天团'], relations: [], onPlayDesc: '【你想想就知道】下家下个回合摸牌后不能出牌；仍可响应吃碰。' },
        '唐洋': { image: 'ty', factions: ['南模天团'], relations: [], onPlayDesc: '【愿者上钩】吃碰此牌者额外摸1张。' },
        '王歆昊': { image: 'wxh', factions: [], relations: [], isWildcard: true, onPlayDesc: '【圣诞礼物】从全场弃牌中随机取回1张普通牌。' },
        '徐翱的针织帽': { image: 'xadzzm', factions: [], relations: ['徐翱'], onPlayDesc: '【助眠神器】出牌时手中有徐翱则自动合体；吃碰者暂停1个回合。' }
    };
    const CLOWN_DESC = '当别人用曾灏铭与刘嘉祺吃牌时，持有徐翱与安以文的玩家可以截取该组合；反向同样有效。截取的羁绊不发动效果，截取者给原吃牌者1张手牌，然后出牌。多名玩家满足时，座位编号最小的玩家获得本次反制机会。';
    const BASIC_RULES = [
        '四人轮转，每人起手9张，共31种牌、每种4张。普通回合摸1张、打1张。',
        '清空手牌获胜；手牌仅剩1张沈鑫浩也立即获胜。牌库耗尽后需要开始摸牌时流局。',
        '只有出牌者的下家能吃碰。吃使用1张有关系的手牌；碰使用同阵营手牌补足要求张数。同名牌可以参与组合。',
        '刘鸿铭、周晓培、王歆昊是万能牌，可补齐阵营；作为弃牌时不可被吃碰。',
        '吃碰后直接出牌。连打期间尚有出牌机会时，打出的牌进入弃牌区；最后1张进入吃碰流程。',
        '合体保留针织帽和徐翱两张实体牌，按徐翱参与组合。额外回合内登场技能与合体失效。',
        '每次完整的卡牌移动和技能效果结束后检查胜利，优先检查当前发动者，再按顺时针检查。',
        '行动超时由AI完成出牌；吃碰与反制超时视为放弃。断线席位保留，AI可暂时代为操作。'
    ];
    function relationKey(first, second) {
        const key = `${first}-${second}`;
        return Object.hasOwn(RELATION_MAP, key) ? key : `${second}-${first}`;
    }
    function matchedFactions(selectedNames, playedName) {
        if (!Object.hasOwn(CARD_DB, playedName) || CARD_DB[playedName].isWildcard) return [];
        return CARD_DB[playedName].factions.filter(f => FACTION_INFO[f].req === selectedNames.length + 1 && selectedNames.every(name =>
            Object.hasOwn(CARD_DB, name) && (CARD_DB[name].isWildcard || CARD_DB[name].factions.includes(f))));
    }
    const rules = { VERSION: '2.5.0', CARD_DB, FACTION_INFO, RELATION_MAP, CLOWN_DESC, BASIC_RULES, relationKey, matchedFactions };
    if (typeof module !== 'undefined') module.exports = rules;
    else globalThis.GameRules = rules;
})();
